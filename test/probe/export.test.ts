/**
 * Metrics pipeline (Unit 5) against a local fixture standing in for VM's
 * OTLP endpoint. Protobuf encodes strings as raw UTF-8, so metric names and
 * label values must appear verbatim in a captured payload — the assertions
 * read the wire bytes, not exporter state.
 *
 * The retry tests also prove the delta-collection subtlety: a bare re-flush
 * after a failed export would push NOTHING (collection consumed the points),
 * so every retried request must carry the metric bytes again.
 */

import { afterAll, describe, expect, test } from "bun:test";

import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import {
  createMetricsPipeline,
  stripClientTimestamps,
  type MetricsPipeline,
} from "../../src/probe/export.ts";
import type { CheckOutcome } from "../../src/probe/checks.ts";

interface CapturedRequest {
  contentType: string | null;
  path: string;
  body: Buffer;
}

/** Fixture VM: captures every POST; answers the scripted status sequence,
 * then 200 forever. */
function vmFixture(statuses: number[] = []) {
  const requests: CapturedRequest[] = [];
  const remaining = [...statuses];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        contentType: request.headers.get("content-type"),
        path: new URL(request.url).pathname,
        body: Buffer.from(await request.arrayBuffer()),
      });
      return new Response(null, { status: remaining.shift() ?? 200 });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

const OUTCOMES: CheckOutcome[] = [
  { service: "grafana", check: "dns-answer", success: true, durationSeconds: 0.012 },
  { service: "grafana", check: "tcp-connect", success: false, durationSeconds: 0.5, detail: "refused" },
];

const pipelines: MetricsPipeline[] = [];
function pipeline(url: string): MetricsPipeline {
  const created = createMetricsPipeline({
    vmBaseUrl: url,
    vantage: "vantage-1",
    view: "vpn",
    retryBackoffMs: [10, 20],
    exportTimeoutMs: 2_000,
  });
  pipelines.push(created);
  return created;
}

afterAll(async () => {
  for (const created of pipelines) await created.shutdown();
});

describe("pushCycle — happy path", () => {
  test("one protobuf POST to VM's OTLP path carrying all three metrics and the D8 labels", async () => {
    const vm = vmFixture();
    const report = await pipeline(vm.url).pushCycle(OUTCOMES);
    vm.server.stop(true);

    expect(report).toEqual({ attempts: 1, delivered: true });
    expect(vm.requests).toHaveLength(1);

    const request = vm.requests[0]!;
    expect(request.path).toBe("/opentelemetry/v1/metrics");
    expect(request.contentType).toBe("application/x-protobuf");
    for (const expected of [
      "infra_probe_success",
      "infra_probe_duration_seconds",
      "infra_probe_last_run_timestamp_seconds",
      "grafana",
      "dns-answer",
      "tcp-connect",
      "vantage-1",
      "vpn",
    ]) {
      expect(request.body.includes(expected)).toBe(true);
    }
  });

  test("an empty cycle (checks: [] view) still delivers the heartbeat, and only the heartbeat", async () => {
    const vm = vmFixture();
    const report = await pipeline(vm.url).pushCycle([]);
    vm.server.stop(true);

    expect(report.delivered).toBe(true);
    const body = vm.requests[0]!.body;
    expect(body.includes("infra_probe_last_run_timestamp_seconds")).toBe(true);
    expect(body.includes("vantage-1")).toBe(true);
    expect(body.includes("infra_probe_success")).toBe(false);
  });
});

describe("pushCycle — retry then drop (D6: 3 attempts, then keep probing)", () => {
  test("a failed push is retried with the samples re-recorded, not an empty flush", async () => {
    const vm = vmFixture([500]);
    const report = await pipeline(vm.url).pushCycle(OUTCOMES);
    vm.server.stop(true);

    expect(report).toEqual({ attempts: 2, delivered: true });
    expect(vm.requests).toHaveLength(2);
    // The retried request carries the real samples again — delta collection
    // consumed them on attempt 1, so this only passes if pushCycle re-records.
    expect(vm.requests[1]!.body.includes("infra_probe_success")).toBe(true);
    expect(vm.requests[1]!.body.includes("grafana")).toBe(true);
  });

  test("after three failures the cycle is dropped and the next cycle still delivers", async () => {
    const vm = vmFixture([500, 500, 500]);
    const shared = pipeline(vm.url);

    const dropped = await shared.pushCycle(OUTCOMES);
    expect(dropped).toEqual({ attempts: 3, delivered: false });
    expect(vm.requests).toHaveLength(3);

    // The exporter keeps probing: the very next cycle pushes clean.
    const recovered = await shared.pushCycle(OUTCOMES);
    vm.server.stop(true);
    expect(recovered).toEqual({ attempts: 1, delivered: true });
    expect(vm.requests).toHaveLength(4);
    expect(vm.requests[3]!.body.includes("infra_probe_success")).toBe(true);
  });

  test("an unreachable VM (connection refused) drops after three attempts without throwing", async () => {
    const vm = vmFixture();
    vm.server.stop(true); // port is now closed — every attempt refuses
    const report = await pipeline(vm.url).pushCycle(OUTCOMES);
    expect(report).toEqual({ attempts: 3, delivered: false });
  });
});

describe("stripClientTimestamps — D8: samples carry no client timestamps", () => {
  test("every data point's start and end time is zeroed in place", () => {
    const metrics = {
      resource: {},
      scopeMetrics: [
        {
          scope: { name: "infra-rules-probe" },
          metrics: [
            {
              dataPoints: [
                { startTime: [1_700_000_000, 123], endTime: [1_700_000_100, 456], value: 1 },
                { startTime: [1_700_000_000, 789], endTime: [1_700_000_100, 12], value: 0 },
              ],
            },
            { dataPoints: [{ startTime: [5, 5], endTime: [6, 6], value: 0.5 }] },
          ],
        },
      ],
    } as unknown as ResourceMetrics;

    stripClientTimestamps(metrics);

    for (const scope of metrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          expect(point.startTime).toEqual([0, 0]);
          expect(point.endTime).toEqual([0, 0]);
        }
      }
    }
  });
});
