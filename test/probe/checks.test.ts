/**
 * Probe check runners (Unit 5), against local fixtures only.
 *
 * THE NO-LOOKUP GUARD. The dns fixture below is a real UDP DNS server on an
 * ephemeral 127.0.0.1 port, and the names it serves (`*.acme.test`) exist
 * NOWHERE else — not in the OS resolver, not in /etc/hosts, not in public
 * DNS. A dns-answer check can therefore only succeed by querying the
 * configured `Resolver`: any code path through `dns.lookup()`, `fetch`, or
 * the OS resolver gets NXDOMAIN and fails the positive tests here. That makes
 * this file the card-mandated test that fails if resolution ever bypasses
 * the Resolver, without spying on internals.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Resolver } from "node:dns/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildResolver, runCheck, type CheckRunOptions } from "../../src/probe/checks.ts";
import { loadConfig, loadCycleChecks, runCycle, type ProbeConfig } from "../../src/probe/main.ts";
import { PROBE_MANIFEST_VERSION } from "../../src/schema/probe.ts";

/** Minimal DNS responder: answers A queries from `records`, NXDOMAIN for
 * unknown names, and stays silent in blackhole mode (timeout tests). */
async function dnsFixture(records: Record<string, string[]>, blackhole = false) {
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(server, query, port, address) {
        if (blackhole) return;
        server.send(dnsResponse(Buffer.from(query), records), port, address);
      },
    },
  });
  return socket;
}

function dnsResponse(query: Buffer, records: Record<string, string[]>): Buffer {
  const labels: string[] = [];
  let offset = 12;
  while (query[offset]! !== 0) {
    const length = query[offset]!;
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString("ascii"));
    offset += length + 1;
  }
  const question = query.subarray(12, offset + 1 + 4); // labels + 0 + QTYPE + QCLASS
  const ips = records[labels.join(".")];

  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2); // ID
  header.writeUInt16BE(ips === undefined ? 0x8183 : 0x8180, 2); // QR|RD|RA, NXDOMAIN | NOERROR
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(ips?.length ?? 0, 6); // ANCOUNT

  const answers = (ips ?? []).map((ip) => {
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0); // name: pointer to the question at offset 12
    answer.writeUInt16BE(1, 2); // TYPE A
    answer.writeUInt16BE(1, 4); // CLASS IN
    answer.writeUInt32BE(60, 6); // TTL
    answer.writeUInt16BE(4, 10); // RDLENGTH
    ip.split(".").forEach((octet, i) => {
      answer[12 + i] = Number(octet);
    });
    return answer;
  });

  return Buffer.concat([header, question, ...answers]);
}

const RECORDS: Record<string, string[]> = {
  "grafana.acme.test": ["192.0.2.10"],
  "multi.acme.test": ["192.0.2.10", "192.0.2.99"],
};

let dns: Awaited<ReturnType<typeof dnsFixture>>;
let options: CheckRunOptions;

beforeAll(async () => {
  dns = await dnsFixture(RECORDS);
  options = { dnsServers: [`127.0.0.1:${dns.port}`], timeoutMs: 1_000 };
});

afterAll(() => {
  dns.close();
});

describe("dns-answer — resolution goes through the configured Resolver only", () => {
  test("answers from the configured server succeed — the OS resolver cannot know this name", async () => {
    const outcome = await runCheck(
      { service: "grafana", check: "dns-answer", dnsName: "grafana.acme.test", expectIp: "192.0.2.10" },
      options,
    );
    expect(outcome).toMatchObject({ service: "grafana", check: "dns-answer", success: true });
    expect(outcome.durationSeconds).toBeGreaterThan(0);
  });

  test("a different answer than expected fails", async () => {
    const outcome = await runCheck(
      { service: "grafana", check: "dns-answer", dnsName: "grafana.acme.test", expectIp: "192.0.2.11" },
      options,
    );
    expect(outcome.success).toBe(false);
    expect(outcome.detail).toContain("192.0.2.10");
  });

  test("NXDOMAIN fails", async () => {
    const outcome = await runCheck(
      { service: "ghost", check: "dns-answer", dnsName: "missing.acme.test", expectIp: "192.0.2.10" },
      options,
    );
    expect(outcome.success).toBe(false);
  });

  test("an extra record beside the expected one fails — 'exactly expectIp'", async () => {
    const outcome = await runCheck(
      { service: "multi", check: "dns-answer", dnsName: "multi.acme.test", expectIp: "192.0.2.10" },
      options,
    );
    expect(outcome.success).toBe(false);
    expect(outcome.detail).toContain("192.0.2.99");
  });

  test("an unanswered query fails within the budget, not never", async () => {
    const blackhole = await dnsFixture({}, true);
    const outcome = await runCheck(
      { service: "grafana", check: "dns-answer", dnsName: "grafana.acme.test", expectIp: "192.0.2.10" },
      { dnsServers: [`127.0.0.1:${blackhole.port}`], timeoutMs: 250 },
    );
    blackhole.close();
    expect(outcome.success).toBe(false);
    expect(outcome.durationSeconds).toBeLessThan(5);
  });
});

describe("buildResolver — getServers() must reflect setServers()", () => {
  test("the applied server list is exactly what was configured", () => {
    const resolver = buildResolver(options);
    expect(resolver.getServers()).toEqual([`127.0.0.1:${dns.port}`]);
  });

  test("port-53 normalization: set with :53, reported bare — still a match", () => {
    expect(() => buildResolver({ dnsServers: ["192.0.2.53:53"], timeoutMs: 1_000 })).not.toThrow();
  });

  test("no configured servers leaves the system resolver config untouched", () => {
    const system = new Resolver().getServers();
    expect(buildResolver({ timeoutMs: 1_000 }).getServers()).toEqual(system);
  });
});

describe("tcp-connect — literal address, no resolution", () => {
  test("an accepting listener is up; the same port refuses after close", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const check = { service: "ssh", check: "tcp-connect", address: "127.0.0.1", port: listener.port } as const;

    const up = await runCheck(check, options);
    expect(up.success).toBe(true);

    listener.stop(true);
    const down = await runCheck(check, options);
    expect(down.success).toBe(false);
  });

  // No unroutable-address timeout test here: on a host running a transparent
  // proxy (TUN mode), SYNs to unrouted space get ACCEPTED by the proxy, so
  // any such fixture is environment-dependent. The refused case above is the
  // deterministic failure path; the budget race is proven on dns (blackhole)
  // and http (hanging server) where local fixtures can hang honestly.
});

describe("http-status — IP-literal URL with Host header", () => {
  test("matches status and sends the manifest dnsName as Host", async () => {
    let seen: { host: string | null; path: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen = { host: request.headers.get("host"), path: new URL(request.url).pathname };
        return new Response(null, { status: 204 });
      },
    });

    const outcome = await runCheck(
      {
        service: "grafana",
        check: "http-status",
        address: "127.0.0.1",
        port: server.port!,
        dnsName: "grafana.acme.test",
        path: "/health",
        expectStatus: 204,
      },
      options,
    );
    server.stop(true);

    expect(outcome.success).toBe(true);
    expect(seen).toEqual({ host: "grafana.acme.test", path: "/health" });
  });

  test("a redirect is observed as its own status, never followed", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, { status: 301, headers: { Location: "http://192.0.2.1:9/gone" } }),
    });
    const check = {
      service: "portal",
      check: "http-status",
      address: "127.0.0.1",
      port: server.port!,
      dnsName: "portal.acme.test",
      path: "/",
    } as const;

    const observed = await runCheck({ ...check, expectStatus: 301 }, options);
    const mismatched = await runCheck({ ...check, expectStatus: 200 }, options);
    server.stop(true);

    expect(observed.success).toBe(true);
    expect(mismatched.success).toBe(false);
    expect(mismatched.detail).toContain("301");
  });

  test("a server that accepts but never answers fails within the budget", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // hang forever
    });
    const outcome = await runCheck(
      {
        service: "tarpit",
        check: "http-status",
        address: "127.0.0.1",
        port: server.port!,
        dnsName: "tarpit.acme.test",
        path: "/",
        expectStatus: 200,
      },
      { ...options, timeoutMs: 250 },
    );
    server.stop(true);
    expect(outcome.success).toBe(false);
    expect(outcome.durationSeconds).toBeLessThan(5);
  });

  test("a refused connection fails", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = server.port!;
    server.stop(true);

    const outcome = await runCheck(
      {
        service: "gone",
        check: "http-status",
        address: "127.0.0.1",
        port,
        dnsName: "gone.acme.test",
        path: "/",
        expectStatus: 200,
      },
      options,
    );
    expect(outcome.success).toBe(false);
  });
});

describe("config — identity comes from env and fails loud (main.ts)", () => {
  const FULL_ENV = {
    PROBE_MANIFEST: "/data/probes.json",
    PROBE_VANTAGE: "vantage-1",
    PROBE_VIEW: "vpn",
    PROBE_VM_URL: "http://127.0.0.1:8428",
  };

  test("a full env parses, with defaults applied", () => {
    expect(loadConfig(FULL_ENV)).toEqual({
      manifestPath: "/data/probes.json",
      vantage: "vantage-1",
      view: "vpn",
      vmBaseUrl: "http://127.0.0.1:8428",
      intervalSeconds: 60,
      checkTimeoutMs: 5_000,
    });
  });

  test("an unset vantage refuses startup by name — an unlabelled exporter would poison absence-vs-zero", () => {
    const { PROBE_VANTAGE: _, ...withoutVantage } = FULL_ENV;
    expect(() => loadConfig(withoutVantage)).toThrow(/PROBE_VANTAGE/);
    expect(() => loadConfig({ ...FULL_ENV, PROBE_VANTAGE: "" })).toThrow(/PROBE_VANTAGE/);
  });

  test("every missing required name is listed at once", () => {
    expect(() => loadConfig({})).toThrow(
      /PROBE_MANIFEST.*PROBE_VANTAGE.*PROBE_VIEW.*PROBE_VM_URL/,
    );
  });

  test("dns servers parse as a trimmed comma list, absent when unset", () => {
    expect(
      loadConfig({ ...FULL_ENV, PROBE_DNS_SERVERS: " 192.0.2.53 , 198.51.100.53:5353 " }).dnsServers,
    ).toEqual(["192.0.2.53", "198.51.100.53:5353"]);
    expect(loadConfig(FULL_ENV).dnsServers).toBeUndefined();
  });

  test("non-positive or non-numeric intervals refuse startup", () => {
    expect(() => loadConfig({ ...FULL_ENV, PROBE_INTERVAL_SECONDS: "abc" })).toThrow(
      /PROBE_INTERVAL_SECONDS/,
    );
    expect(() => loadConfig({ ...FULL_ENV, PROBE_INTERVAL_SECONDS: "0" })).toThrow(
      /PROBE_INTERVAL_SECONDS/,
    );
  });
});

describe("cycle — the manifest is re-read from disk every run (main.ts)", () => {
  const dir = join(import.meta.dir, "..", "..", ".scratch", `cycle-test-${process.pid}`);
  const manifestPath = join(dir, "probes.json");

  function writeManifest(views: Array<{ view: string; checks: unknown[] }>): void {
    writeFileSync(manifestPath, JSON.stringify({ manifestVersion: PROBE_MANIFEST_VERSION, views }));
  }

  function config(view: string): ProbeConfig {
    return {
      manifestPath,
      vantage: "vantage-1",
      view,
      vmBaseUrl: "http://127.0.0.1:9",
      intervalSeconds: 60,
      checkTimeoutMs: 1_000,
      dnsServers: [`127.0.0.1:${dns.port}`],
    };
  }

  beforeAll(() => mkdirSync(dir, { recursive: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("checks: [] is a run — zero outcomes, no error (answerable-service-free view)", async () => {
    writeManifest([{ view: "empty", checks: [] }]);
    expect(await runCycle(config("empty"))).toEqual([]);
  });

  test("a rewritten manifest is honored on the very next cycle", async () => {
    const check = {
      service: "grafana",
      check: "dns-answer",
      dnsName: "grafana.acme.test",
      expectIp: "192.0.2.10",
    };
    writeManifest([{ view: "vpn", checks: [check] }]);
    const first = await runCycle(config("vpn"));
    expect(first.map((outcome) => outcome.success)).toEqual([true]);

    writeManifest([{ view: "vpn", checks: [{ ...check, expectIp: "192.0.2.77" }] }]);
    const second = await runCycle(config("vpn"));
    expect(second.map((outcome) => outcome.success)).toEqual([false]);
  });

  test("a missing section names itself and what exists", async () => {
    writeManifest([{ view: "vpn", checks: [] }]);
    await expect(loadCycleChecks(config("office"))).rejects.toThrow(/view "office".*vpn/);
  });

  test("a malformed or version-bumped manifest refuses to parse", async () => {
    writeFileSync(manifestPath, "not json");
    await expect(loadCycleChecks(config("vpn"))).rejects.toThrow();

    writeFileSync(manifestPath, JSON.stringify({ manifestVersion: 2, views: [] }));
    await expect(loadCycleChecks(config("vpn"))).rejects.toThrow();
  });

  test("the rendered file's DO NOT EDIT header (_generated) is tolerated", async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestVersion: PROBE_MANIFEST_VERSION,
        views: [{ view: "vpn", checks: [] }],
        _generated: "DO NOT EDIT — rendered by infra-rules",
      }),
    );
    expect(await runCycle(config("vpn"))).toEqual([]);
  });
});
