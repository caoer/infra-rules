/**
 * Probe exporter entry point (Unit 5): a stateless interval runner compiled
 * to a single-file artifact with `bun build --compile`.
 *
 * DEPLOYMENT CONTRACT (U4 gate addendum). The rendered manifest is sectioned
 * by VIEW; a vantage is a deployed exporter, not a registry entity. This
 * process is deployed with exactly two identity facts — `PROBE_VANTAGE` (the
 * vantage label, unique per deployment) and `PROBE_VIEW` (the manifest
 * section it runs) — and with the per-record fields they cover all four D8
 * labels. The vantage label comes from env ONLY: never inferred from the
 * manifest, and startup fails loud when it is unset, because an unlabelled
 * exporter would poison the heartbeat's absence-vs-zero distinction.
 *
 * STATELESSNESS. The manifest is re-read from disk every cycle (a mid-run
 * render lands within one interval); nothing is persisted; runtime errors
 * never exit the process. A cycle that cannot run (unreadable manifest,
 * vanished section) is skipped WITHOUT advancing the heartbeat — the metric
 * claims "last run", and a skipped cycle is not a run. `checks: []` IS a run:
 * an answerable-service-free view heartbeats with zero service metrics.
 */

import { readFile } from "node:fs/promises";
import { ProbeManifestSchema, type ProbeCheck } from "../schema/probe.ts";
import { buildResolver, runCheck, type CheckOutcome } from "./checks.ts";
import { createMetricsPipeline, verifyIngest } from "./export.ts";

const REQUIRED_ENV = ["PROBE_MANIFEST", "PROBE_VANTAGE", "PROBE_VIEW", "PROBE_VM_URL"] as const;
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
/**
 * How often the exporter re-proves its own ingest (review #6).
 *
 * Not once per process: a single optimistic verification at startup is a claim
 * about one minute of a service that runs for months, and the failure it must
 * catch (VM dropping samples) arrives later, not at boot.
 *
 * Not once per cycle either: one run costs up to ~40s of retries because VM's
 * search latency offset (30s) hides a just-delivered sample, so a per-cycle
 * check would spend most of a 60s cycle polling VM to learn nothing new.
 *
 * 15 minutes bounds "alive but exporting into the void" to one window, at one
 * query per 15 cycles on the default interval.
 */
const DEFAULT_VERIFY_INTERVAL_SECONDS = 900;

export interface ProbeConfig {
  manifestPath: string;
  vantage: string;
  view: string;
  vmBaseUrl: string;
  intervalSeconds: number;
  checkTimeoutMs: number;
  verifyIntervalSeconds: number;
  dnsServers?: string[];
}

function positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

/** Env is the whole config surface (nix wires it, U11). Missing identity or
 * target env refuses startup with every missing name listed — an exporter
 * guessing any of these would emit poisoned series. */
export function loadConfig(env: Record<string, string | undefined>): ProbeConfig {
  const missing = REQUIRED_ENV.filter((name) => env[name] === undefined || env[name] === "");
  if (missing.length > 0) {
    throw new Error(`probe exporter refusing to start — required env unset: ${missing.join(", ")}`);
  }

  const config: ProbeConfig = {
    manifestPath: env.PROBE_MANIFEST!,
    vantage: env.PROBE_VANTAGE!,
    view: env.PROBE_VIEW!,
    vmBaseUrl: env.PROBE_VM_URL!,
    intervalSeconds: positiveNumber(env, "PROBE_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS),
    checkTimeoutMs: positiveNumber(env, "PROBE_CHECK_TIMEOUT_MS", DEFAULT_CHECK_TIMEOUT_MS),
    verifyIntervalSeconds: positiveNumber(
      env,
      "PROBE_VERIFY_INTERVAL_SECONDS",
      DEFAULT_VERIFY_INTERVAL_SECONDS,
    ),
  };

  const servers = (env.PROBE_DNS_SERVERS ?? "")
    .split(",")
    .map((server) => server.trim())
    .filter((server) => server !== "");
  if (servers.length > 0) config.dnsServers = servers;

  return config;
}

/** One cycle's checks: read → strict-parse (asserts `manifestVersion`) →
 * select this deployment's section. Throws on any failure; the caller
 * decides startup-fatal vs cycle-skip. */
export async function loadCycleChecks(config: ProbeConfig): Promise<ProbeCheck[]> {
  const manifest = ProbeManifestSchema.parse(JSON.parse(await readFile(config.manifestPath, "utf8")));
  const section = manifest.views.find((entry) => entry.view === config.view);
  if (section === undefined) {
    const sections = manifest.views.map((entry) => entry.view).join(", ");
    throw new Error(`view "${config.view}" not in manifest (sections: ${sections})`);
  }
  return section.checks;
}

/** Load-and-run one cycle, sequentially — cycles are small (tens of checks)
 * and sequential runs keep durations honest and load trivial. */
export async function runCycle(config: ProbeConfig): Promise<CheckOutcome[]> {
  const checks = await loadCycleChecks(config);
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    outcomes.push(
      await runCheck(check, { dnsServers: config.dnsServers, timeoutMs: config.checkTimeoutMs }),
    );
  }
  return outcomes;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface IngestSelfCheck {
  /** Call once per cycle with that cycle's delivery result. Never throws,
   * never blocks: a due check is started detached and settles later. */
  onCycle(delivered: boolean): void;
  /** What the last CONCLUDED check found — `undefined` until one concludes.
   * Never set from a check that has only been started. */
  readonly verified: boolean | undefined;
  /** The check currently in flight, for tests that must await a conclusion. */
  readonly settled: Promise<void> | undefined;
}

/**
 * The exporter proving, repeatedly, that its samples reach storage.
 *
 * Two rules, both of them the review #6 defect:
 *
 * - HEALTH IS NEVER ASSUMED. `verified` moves only when a check RESOLVES.
 *   The old code set the latch before awaiting the promise, so a failed
 *   verification could never be retried and the process kept reporting a
 *   health it had never observed.
 * - HEALTH EXPIRES. A concluded check is good for `intervalMs`, after which
 *   the next delivered cycle re-proves it. A false result clears the flag and
 *   logs loudly, so the journal shows the transition rather than one stale
 *   line from boot.
 *
 * Only delivered cycles arm it: a cycle that never reached VM has nothing to
 * verify, and querying back for it would report a failure the push already
 * reported.
 */
export function createIngestSelfCheck(options: {
  verify: () => Promise<boolean>;
  intervalMs: number;
  now?: () => number;
  log?: (line: string) => void;
}): IngestSelfCheck {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  let verified: boolean | undefined;
  let concludedAt: number | undefined;
  let settled: Promise<void> | undefined;

  return {
    get verified() {
      return verified;
    },
    get settled() {
      return settled;
    },
    onCycle(delivered: boolean): void {
      if (!delivered) return;
      if (settled !== undefined) return; // one in flight; it outlives a cycle
      if (concludedAt !== undefined && now() - concludedAt < options.intervalMs) return;

      const wasVerified = verified;
      settled = options.verify()
        .catch(() => false)
        .then((present) => {
          verified = present;
          concludedAt = now();
          log(
            present
              ? "[probe] ingest verified: series queryable"
              : "[probe] WARNING ingest NOT verified — pushes report success but the " +
                  "heartbeat series is not queryable after retrying past the search " +
                  "latency offset. Metrics are being dropped." +
                  (wasVerified === true ? " (it was queryable at the last check)" : ""),
          );
        })
        .finally(() => {
          settled = undefined;
        });
    },
  };
}

export async function main(): Promise<never> {
  let config: ProbeConfig;
  try {
    config = loadConfig(process.env);
    // Startup validation, fail loud: resolver config applies (getServers
    // assert inside buildResolver) and the manifest is readable with this
    // deployment's section present. After startup the same failures degrade
    // to skipped cycles — env cannot change mid-run, the manifest can.
    buildResolver({ dnsServers: config.dnsServers, timeoutMs: config.checkTimeoutMs });
    await loadCycleChecks(config);
  } catch (error) {
    console.error(`[probe] startup: ${message(error)}`);
    process.exit(1);
  }

  const pipeline = createMetricsPipeline({
    vmBaseUrl: config.vmBaseUrl,
    vantage: config.vantage,
    view: config.view,
  });
  console.error(
    `[probe] started: vantage=${config.vantage} view=${config.view} ` +
      `manifest=${config.manifestPath} vm=${config.vmBaseUrl} interval=${config.intervalSeconds}s`,
  );

  const selfCheck = createIngestSelfCheck({
    verify: () => verifyIngest(config.vmBaseUrl, config),
    intervalMs: config.verifyIntervalSeconds * 1000,
    log: (line) => console.error(`${line} vantage=${config.vantage} vm=${config.vmBaseUrl}`),
  });

  while (true) {
    const cycleStarted = Date.now();
    try {
      const outcomes = await runCycle(config);
      const failed = outcomes.filter((outcome) => !outcome.success);
      for (const outcome of failed) {
        console.error(
          `[probe] FAIL ${outcome.service}/${outcome.check}` +
            (outcome.detail !== undefined ? `: ${outcome.detail}` : ""),
        );
      }
      const report = await pipeline.pushCycle(outcomes);
      console.error(
        `[probe] cycle: ${outcomes.length} checks, ${outcomes.length - failed.length} ok, ` +
          `${failed.length} failed; delivered=${report.delivered} attempts=${report.attempts}`,
      );

      // Delivered is not ingested. A push can be accepted, counted, and
      // stored as nothing (VM drops samples whose timestamps it rejects) —
      // every in-process signal still says success. So ask VM, periodically,
      // whether the series actually exists; the scheduler owns the cadence
      // and starts the query detached, because probing must not stall on it.
      selfCheck.onCycle(report.delivered);
    } catch (error) {
      console.error(`[probe] cycle skipped (no heartbeat): ${message(error)}`);
    }
    const elapsedMs = Date.now() - cycleStarted;
    await Bun.sleep(Math.max(config.intervalSeconds * 1000 - elapsedMs, 1_000));
  }
}

if (import.meta.main) void main();
