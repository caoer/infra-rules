/**
 * Check runners for the probe exporter (Unit 5). One runner per manifest
 * check kind; `runCheck` never throws — a probe process that dies on a weird
 * network answer stops observing, which is the failure mode this unit exists
 * to prevent.
 *
 * RESOLUTION DISCIPLINE. DNS answers come from an explicit `Resolver` +
 * `resolve4()` — never `dns.lookup()`, never `fetch`/`net` given a hostname.
 * On bun 1.3.x `Resolver.setServers()` works, but `dns.lookup()` silently
 * ignores it (only `resolve*()` honors it), and `fetch`/`net` resolve through
 * `lookup`. A probe using any of those would validate the OS resolver's view
 * while labeling the result as the vantage's view — silently wrong data, the
 * exact failure class (`e1af49a`/`b5497b2`) this exporter exists to catch.
 * tcp-connect and http-status are handed literal IPv4 addresses by the
 * manifest (schema-enforced `z.ipv4()`), so nothing else resolves anything.
 */

import { Resolver } from "node:dns/promises";
import { connect } from "node:net";
import type { ProbeCheck } from "../schema/probe.ts";

export interface CheckRunOptions {
  /** Explicit DNS servers for the vantage (`ip` or `ip:port`). Unset = the
   * host's own resolver config, which on a correctly-deployed vantage IS the
   * view's resolver. */
  dnsServers?: string[] | undefined;
  /** Per-check budget; a check that outlives it fails. */
  timeoutMs: number;
}

export interface CheckOutcome {
  service: string;
  check: ProbeCheck["check"];
  success: boolean;
  durationSeconds: number;
  /** Failure reason for the operator log; never a metric label. */
  detail?: string;
}

/** `getServers()` reports `ip` for port 53 and `ip:port` otherwise — bring
 * configured values to the same shape so the assert compares like with like. */
function normalizeServer(server: string): string {
  return server.endsWith(":53") ? server.slice(0, -3) : server;
}

/**
 * Build the resolver dns-answer checks query. When explicit servers are
 * configured, assert `getServers()` reflects them (the card's mandate): a
 * resolver silently not pointing where deployment said would produce
 * wrong-vantage answers. Throws on mismatch — validate at startup, where a
 * config bug fails loud instead of metering red forever.
 */
export function buildResolver(options: CheckRunOptions): Resolver {
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: 1 });
  const servers = options.dnsServers;
  if (servers !== undefined && servers.length > 0) {
    resolver.setServers(servers);
    const applied = resolver.getServers().map(normalizeServer).sort();
    const configured = [...servers].map(normalizeServer).sort();
    if (
      applied.length !== configured.length ||
      applied.some((server, i) => server !== configured[i])
    ) {
      throw new Error(
        `resolver did not apply the configured servers: set [${configured.join(", ")}], ` +
          `getServers() reports [${applied.join(", ")}]`,
      );
    }
  }
  return resolver;
}

/** Race a resolution against the check budget; on timeout, cancel the
 * resolver's in-flight queries (each check owns a fresh resolver, so a cancel
 * never bleeds into another check). */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface RunResult {
  success: boolean;
  detail?: string;
}

/**
 * "Require the answer to be exactly `expectIp`" (schema contract): at least
 * one answer, and no answer other than `expectIp` — an extra wrong record
 * would steer clients to the wrong address even with the right one present.
 */
async function runDnsAnswer(
  check: Extract<ProbeCheck, { check: "dns-answer" }>,
  options: CheckRunOptions,
): Promise<RunResult> {
  const resolver = buildResolver(options);
  const answers = await withTimeout(resolver.resolve4(check.dnsName), options.timeoutMs, () =>
    resolver.cancel(),
  );
  if (answers.length === 0) return { success: false, detail: "no A records" };
  if (answers.some((ip) => ip !== check.expectIp)) {
    return { success: false, detail: `expected exactly ${check.expectIp}, got [${answers.join(", ")}]` };
  }
  return { success: true };
}

/** A TCP handshake to the literal address — established connection = up.
 * node connects IP literals directly; no resolver is consulted. */
function runTcpConnect(
  check: Extract<ProbeCheck, { check: "tcp-connect" }>,
  options: CheckRunOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: check.address, port: check.port });
    const finish = (result: RunResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(options.timeoutMs, () =>
      finish({ success: false, detail: `timeout after ${options.timeoutMs}ms` }),
    );
    socket.once("connect", () => finish({ success: true }));
    socket.once("error", (error) => finish({ success: false, detail: error.message }));
  });
}

/** `GET http://address:port/path` with `Host: dnsName` — an IP-literal URL,
 * so fetch performs no resolution. `redirect: "manual"` keeps the observed
 * status the service's own answer, never a location it redirected to. */
async function runHttpStatus(
  check: Extract<ProbeCheck, { check: "http-status" }>,
  options: CheckRunOptions,
): Promise<RunResult> {
  const response = await fetch(`http://${check.address}:${check.port}${check.path}`, {
    headers: { Host: check.dnsName },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  await response.body?.cancel();
  if (response.status !== check.expectStatus) {
    return { success: false, detail: `expected status ${check.expectStatus}, got ${response.status}` };
  }
  return { success: true };
}

/** Run one manifest check to an outcome. Catches everything: an unexpected
 * throw is a failed check with the error as detail, never a dead process. */
export async function runCheck(check: ProbeCheck, options: CheckRunOptions): Promise<CheckOutcome> {
  const started = performance.now();
  let result: RunResult;
  try {
    switch (check.check) {
      case "dns-answer":
        result = await runDnsAnswer(check, options);
        break;
      case "tcp-connect":
        result = await runTcpConnect(check, options);
        break;
      case "http-status":
        result = await runHttpStatus(check, options);
        break;
    }
  } catch (error) {
    result = { success: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const outcome: CheckOutcome = {
    service: check.service,
    check: check.check,
    success: result.success,
    durationSeconds: (performance.now() - started) / 1000,
  };
  if (result.detail !== undefined) outcome.detail = result.detail;
  return outcome;
}
