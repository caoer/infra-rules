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
 * - NO CLIENT SAMPLE TIMESTAMPS: every data point's start/end time is zeroed
 *   before serialization (`stripClientTimestamps`), so VM assigns arrival
 *   time server-side — clock-skew immunity. The heartbeat's VALUE is a client
 *   clock reading (that is what the metric name promises); the SAMPLE
 *   timestamp is what stays server-assigned. U11 verifies the zero-timestamp
 *   behavior against a real VM with a real push.
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

/** Zero every data point's timestamps in place, so the wire carries
 * `timeUnixNano = 0` and VM assigns arrival time server-side (D8). The
 * fields are typed readonly by the SDK; the collected snapshot is ours to
 * mutate before serialization. */
export function stripClientTimestamps(metrics: ResourceMetrics): void {
  const zero: HrTime = [0, 0];
  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const point of metric.dataPoints) {
        const mutable = point as { startTime: HrTime; endTime: HrTime };
        mutable.startTime = zero;
        mutable.endTime = zero;
      }
    }
  }
}

/** The proto exporter, with timestamps stripped on the way out and the last
 * export result captured where the retry loop can read it — the SDK's own
 * flush surface does not report per-export success reliably. */
class VmMetricExporter extends OTLPMetricExporter {
  private lastResult: ExportResult | undefined;

  override export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    stripClientTimestamps(metrics);
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
