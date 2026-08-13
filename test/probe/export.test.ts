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
  sampleTimestampsSeconds,
  verifyIngest,
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
  /**
   * Sample timestamps as seen ON THE WIRE, in seconds.
   *
   * OTLP encodes `time_unix_nano` as protobuf fixed64, so every 8-byte
   * little-endian window that decodes to a plausible epoch-nanosecond value
   * is a timestamp the collector sent. Reading the bytes rather than the
   * in-process snapshot is deliberate: the bug this guards against was
   * invisible to every in-process signal, and only what reaches VM matters.
   */
  const exportedSampleTimestampsSeconds = (): number[] => {
    const found: number[] = [];
    const lowerNs = BigInt(Date.now() - 3_600_000) * 1_000_000n;
    const upperNs = BigInt(Date.now() + 3_600_000) * 1_000_000n;
    for (const request of requests) {
      for (let offset = 0; offset + 8 <= request.body.length; offset++) {
        const value = request.body.readBigUInt64LE(offset);
        if (value >= lowerNs && value <= upperNs) found.push(Number(value / 1_000_000n) / 1000);
      }
    }
    return found;
  };

  return {
    server,
    requests,
    exportedSampleTimestampsSeconds,
    url: `http://127.0.0.1:${server.port}`,
  };
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

describe("sample timestamps — the samples must be STORABLE, not just accepted", () => {
  /**
   * This unit originally zeroed every sample timestamp so VM would assign
   * arrival time server-side. Real VictoriaMetrics discards those samples at
   * storage (`vm_rows_ignored_total{reason="small_timestamp"}`): 21 of 22
   * rows dropped on VM 1.148.0 and 1.145.0, `infra_probe_success` never
   * queryable — while the POST returned 2xx, the SDK reported SUCCESS, and
   * the exporter logged `delivered=true`. No signal inside this process
   * could see it.
   *
   * So the guard is on the wire values, not on the delivery result.
   */
  test("exported samples carry real, recent timestamps — never zero or ancient", async () => {
    const vm = vmFixture();
    const report = await pipeline(vm.url).pushCycle(OUTCOMES);
    expect(report.delivered).toBe(true);

    const seconds = vm.exportedSampleTimestampsSeconds();
    expect(seconds.length).toBeGreaterThan(0);

    // VM rejects anything it reads as far in the past; zero is the extreme
    // case. Assert every sample sits inside a sane window around now.
    const now = Date.now() / 1000;
    for (const sample of seconds) {
      expect(sample).toBeGreaterThan(now - 300);
      expect(sample).toBeLessThan(now + 300);
    }
  });

  test("sampleTimestampsSeconds reads the collected snapshot's times", () => {
    const metrics = {
      resource: {},
      scopeMetrics: [
        {
          scope: { name: "infra-rules-probe" },
          metrics: [
            { dataPoints: [{ startTime: [1_700_000_000, 0], endTime: [1_700_000_100, 500_000_000], value: 1 }] },
          ],
        },
      ],
    } as unknown as ResourceMetrics;

    expect(sampleTimestampsSeconds(metrics)).toEqual([1_700_000_100.5]);
  });
});

describe("verifyIngest — delivered is not ingested", () => {
  test("true only when VM actually returns the series", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ data: { result: [{ metric: {}, value: [0, "1"] }] } }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const url = `http://127.0.0.1:${server.port}`;
    expect(await verifyIngest(url, { vantage: "edge-1", view: "vpn" })).toBe(true);
    server.stop(true);
  });

  test("false when VM returns an empty result — the silent-drop case", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ data: { result: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const url = `http://127.0.0.1:${server.port}`;
    expect(await verifyIngest(url, { vantage: "edge-1", view: "vpn" })).toBe(false);
    server.stop(true);
  });

  test("false, never a throw, when VM is unreachable — reports not-proven", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${server.port}`;
    server.stop(true);
    expect(await verifyIngest(url, { vantage: "v", view: "w" }, 500)).toBe(false);
  });
});
