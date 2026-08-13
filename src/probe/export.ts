/**
 * Metrics pipeline: OTel SDK → OTLP/HTTP protobuf → the local VictoriaMetrics.
 *
 * D7, settled by this unit's spike (2026-08-13): the OTel SDK bundles,
 * compiles, and runs clean under `bun build --compile` — the compiled
 * artifact POSTs valid `application/x-protobuf` — so the SDK primary ships.
 * The `/api/v1/import/prometheus` text-push fallback was never triggered.
 *
 * How the D8 contract lands here:
 *
 * - REAL SAMPLE TIMESTAMPS, and D8's clock-skew intent is still met.
 *   This unit first zeroed every sample timestamp so VM would assign arrival
 *   time server-side. Real VictoriaMetrics DISCARDS those samples at storage
 *   (`vm_rows_ignored_total{reason="small_timestamp"}`) — verified on VM
 *   1.148.0 and 1.145.0, 21 of 22 rows dropped, `infra_probe_success` never
 *   queryable. Nothing inside the exporter could see it: the POST returns
 *   2xx, the SDK reports SUCCESS, and VM counts the rows as inserted before
 *   dropping them. DELIVERED IS NOT INGESTED — only a query-back proves
 *   ingest, which is why `verifyIngest` exists below.
 *
 *   So samples now carry their real collection time. The heartbeat's VALUE
 *   stays a client clock reading (that is what the metric name promises), and
 *   skew protection moves to query time where VM can actually provide it.
 *
 * - DELTA temporality: a sync gauge under delta collection exports only the
 *   attribute sets recorded since the last collect, so a service that leaves
 *   the manifest stops being exported the next cycle — under cumulative it
 *   would ghost at its last value forever.
 *
 * - RETRY 3× (1s, 5s), THEN DROP: each retry re-records the cycle's outcomes
 *   (delta collection consumes state on every attempt, so a bare re-flush
 *   would push nothing) and re-flushes. After the last failure the samples
 *   are dropped and the exporter keeps probing — heartbeat staleness in VM is
 *   itself the signal that pushes are failing. Never buffer, never exit.
 */

import type { HrTime } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { emptyResource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import type { CheckOutcome } from "./checks.ts";

/** VM mounts OTLP under this prefix (standard path is `/v1/metrics`). */
const VM_OTLP_PATH = "/opentelemetry/v1/metrics";
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000];
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;

/**
 * Every data point's sample timestamp, as seconds since the epoch.
 *
 * Exists so a test can assert the wire carries REAL times: a zero (or
 * otherwise ancient) timestamp is silently discarded by VictoriaMetrics at
 * storage while every signal inside this process still reports success.
 */
export function sampleTimestampsSeconds(metrics: ResourceMetrics): number[] {
  const seconds: number[] = [];
  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const point of metric.dataPoints) {
        const [s, ns] = point.endTime as HrTime;
        seconds.push(s + ns / 1e9);
      }
    }
  }
  return seconds;
}

/** The proto exporter, with the last export result captured where the retry
 * loop can read it — the SDK's own flush surface does not report per-export
 * success reliably. */
class VmMetricExporter extends OTLPMetricExporter {
  private lastResult: ExportResult | undefined;

  override export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    super.export(metrics, (result) => {
      this.lastResult = result;
      resultCallback(result);
    });
  }

  /** The result of the export the last flush ran, cleared on read — an
   * attempt whose export never fired reads as undefined, i.e. not delivered. */
  takeLastResult(): ExportResult | undefined {
    const result = this.lastResult;
    this.lastResult = undefined;
    return result;
  }
}

export interface PipelineOptions {
  /** VM base URL, e.g. `http://127.0.0.1:8428` — `VM_OTLP_PATH` is appended. */
  vmBaseUrl: string;
  /** Deployment-owned identity labels (addendum: never inferred). */
  vantage: string;
  view: string;
  /** Test injection points; production uses the defaults. */
  retryBackoffMs?: readonly number[];
  exportTimeoutMs?: number;
}

export interface PushReport {
  attempts: number;
  delivered: boolean;
}

export interface MetricsPipeline {
  /** Record one completed cycle's outcomes plus the heartbeat, and push to
   * VM with the D6 retry-then-drop policy. Resolves always — never throws. */
  pushCycle(outcomes: CheckOutcome[]): Promise<PushReport>;
  /** Flush-and-stop for tests; the production loop never calls it. */
  shutdown(): Promise<void>;
}

/**
 * Query VM back for this vantage's heartbeat series, retrying past VM's
 * search latency offset.
 *
 * Why this exists: a push can be accepted, counted, and still stored as
 * nothing. `delivered=true` is a statement about the POST, not about the
 * database, so the only honest proof of ingest is asking VM whether the
 * series is there.
 *
 * Why it RETRIES: VM applies `-search.latencyOffset` (30s by default), so a
 * just-delivered sample is not yet visible to an instant query even though
 * it is stored — `/api/v1/export` shows it while `/api/v1/query` does not.
 * Checking once would report failure on every healthy start, and a warning
 * that fires on every clean start is one operators learn to ignore. That
 * would convert this check into exactly the silence it exists to break.
 *
 * Returns false only after every attempt has failed, including an
 * unreachable VM: this reports "not proven", never "fine".
 */
export const DEFAULT_INGEST_RETRY_MS: readonly number[] = [5_000, 15_000, 20_000];

export async function verifyIngest(
  vmBaseUrl: string,
  labels: { vantage: string; view: string },
  options: { timeoutMs?: number; retryMs?: readonly number[] } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? DEFAULT_INGEST_RETRY_MS;
  const query = `infra_probe_last_run_timestamp_seconds{vantage=${JSON.stringify(labels.vantage)},view=${JSON.stringify(labels.view)}}`;
  const url = `${vmBaseUrl.replace(/\/+$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;

  for (let attempt = 0; attempt <= retryMs.length; attempt++) {
    if (attempt > 0) await Bun.sleep(retryMs[attempt - 1]!);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        const body = (await response.json()) as { data?: { result?: unknown[] } };
        if ((body.data?.result?.length ?? 0) > 0) return true;
      }
    } catch {
      // fall through to the next attempt
    }
  }
  return false;
}

export function createMetricsPipeline(options: PipelineOptions): MetricsPipeline {
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const exporter = new VmMetricExporter({
    url: options.vmBaseUrl.replace(/\/+$/, "") + VM_OTLP_PATH,
    timeoutMillis: options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
    temporalityPreference: AggregationTemporality.DELTA,
  });
  // Interval effectively-never: the cycle loop drives every export through
  // forceFlush, so pushes stay aligned to probe cycles.
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 0x7fffffff,
    exportTimeoutMillis: options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
  });
  // Empty resource: metric identity is carried entirely by the D8 data-point
  // labels; default SDK resource attributes would only add junk series risk.
  const provider = new MeterProvider({ resource: emptyResource(), readers: [reader] });

  const meter = provider.getMeter("infra-rules-probe");
  const success = meter.createGauge("infra_probe_success", {
    description: "1 = check passed from this vantage, 0 = failed",
  });
  const duration = meter.createGauge("infra_probe_duration_seconds", {
    description: "Wall time of the individual check",
  });
  const heartbeat = meter.createGauge("infra_probe_last_run_timestamp_seconds", {
    description:
      "Per-vantage heartbeat: client clock at cycle completion. Absence/staleness = exporter or vantage dead; distinct from success=0",
  });

  function record(outcomes: CheckOutcome[], completedAtSeconds: number): void {
    for (const outcome of outcomes) {
      const attributes = {
        service: outcome.service,
        check: outcome.check,
        vantage: options.vantage,
        view: options.view,
      };
      success.record(outcome.success ? 1 : 0, attributes);
      duration.record(outcome.durationSeconds, attributes);
    }
    heartbeat.record(completedAtSeconds, { vantage: options.vantage, view: options.view });
  }

  return {
    async pushCycle(outcomes: CheckOutcome[]): Promise<PushReport> {
      const completedAtSeconds = Date.now() / 1000;
      const attempts = backoffMs.length + 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) await Bun.sleep(backoffMs[attempt - 2]!);
        record(outcomes, completedAtSeconds);
        try {
          await provider.forceFlush();
        } catch {
          // Failure is read from takeLastResult below; some SDK versions
          // reject the flush on export failure, some only log.
        }
        const result = exporter.takeLastResult();
        if (result?.code === ExportResultCode.SUCCESS) {
          return { attempts: attempt, delivered: true };
        }
        console.error(
          `[probe] VM push attempt ${attempt}/${attempts} failed: ${
            result?.error?.message ?? "no export result"
          }`,
        );
      }
      console.error(
        `[probe] dropping this cycle's samples after ${attempts} attempts — heartbeat staleness is the signal`,
      );
      return { attempts, delivered: false };
    },

    shutdown(): Promise<void> {
      return provider.shutdown();
    },
  };
}
