import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { renderProbes } from "../../src/render/probes.ts";
import { ProbeManifestSchema } from "../../src/schema/probe.ts";
import { buildFileSet } from "../../src/commands/render.ts";
import { stampHeader } from "../../src/lib/canonical.ts";
import type { Renderer } from "../../src/render/index.ts";
import type { Registry } from "../../src/schema/registry.ts";

/**
 * Synthetic fleet, built so every view has a host the OTHER view cannot see:
 *
 *   web-1   mesh + lan   → answerable in both views
 *   jump-1  mesh only    → no answer in `office`
 *   nas-1   lan only     → no answer in `vpn`
 */
const MESH_IP_WEB = "10.99.14.10";
const MESH_IP_JUMP = "10.99.14.11";
const LAN_IP_WEB = "192.0.2.10";
const LAN_IP_NAS = "192.0.2.20";

const registry: Registry = {
  schemaVersion: 1,
  snapshots: {
    acme: [
      {
        kind: "host",
        name: "web-1",
        mesh: "mesh-a",
        easytier_ip: MESH_IP_WEB,
        networks: { lab: { ip: LAN_IP_WEB } },
      },
      { kind: "host", name: "jump-1", roles: ["jumper"], mesh: "mesh-a", easytier_ip: MESH_IP_JUMP },
      { kind: "mesh", name: "mesh-a", cidr: "10.99.0.0/16" },
      {
        kind: "network",
        name: "lab",
        cidr: "192.0.2.0/24",
        allocation: { vocabulary: "org-site-band", org: "acme", site: "hq", band: 2 },
      },
    ],
  },
  hand: [
    { kind: "host", name: "nas-1", networks: { lab: { ip: LAN_IP_NAS } } },
    { kind: "view", name: "vpn", scope: { kind: "mesh", mesh: "mesh-a" } },
    { kind: "view", name: "office", scope: { kind: "network", network: "lab" } },
    {
      kind: "service",
      name: "grafana",
      dnsName: "grafana.acme.test",
      host: "web-1",
      port: 3000,
      http: { path: "/health", expectStatus: 204 },
    },
    { kind: "service", name: "jump-ssh", dnsName: "jump.acme.test", host: "jump-1", port: 22 },
    {
      kind: "service",
      name: "nas-ui",
      dnsName: "nas.acme.test",
      host: "nas-1",
      port: 80,
      http: {},
    },
    { kind: "service", name: "portal", dnsName: "portal.acme.test", host: "web-1" },
  ],
};

function section(manifest: ReturnType<typeof renderProbes>, view: string) {
  const found = manifest.views.find((entry) => entry.view === view);
  if (found === undefined) throw new Error(`no section for view "${view}"`);
  return found;
}

describe("probes manifest — per-view grouping", () => {
  test("one section per view, name-sorted, and the rendered file parses as a manifest", () => {
    const manifest = renderProbes(registry);
    expect(manifest.views.map((entry) => entry.view)).toEqual(["office", "vpn"]);
    expect(ProbeManifestSchema.parse(stampHeader(manifest))).toBeDefined();
  });

  test("a view with no answerable service renders an empty check list, not a missing section", () => {
    const empty: Registry = {
      schemaVersion: 1,
      snapshots: {},
      hand: [{ kind: "view", name: "lonely", scope: { kind: "mesh", mesh: "nowhere" } }],
    };
    expect(renderProbes(empty).views).toEqual([{ view: "lonely", checks: [] }]);
  });
});

describe("probes manifest — the omit rule", () => {
  test("a host with no answer for a view contributes no checks to it", () => {
    const manifest = renderProbes(registry);
    expect(new Set(section(manifest, "office").checks.map((check) => check.service))).toEqual(
      new Set(["grafana", "nas-ui", "portal"]),
    );
    expect(new Set(section(manifest, "vpn").checks.map((check) => check.service))).toEqual(
      new Set(["grafana", "jump-ssh", "portal"]),
    );
  });

  test("no view's section ever carries another view's address", () => {
    const manifest = renderProbes(registry);
    const office = JSON.stringify(section(manifest, "office"));
    const vpn = JSON.stringify(section(manifest, "vpn"));

    for (const meshIp of [MESH_IP_WEB, MESH_IP_JUMP]) expect(office).not.toContain(meshIp);
    for (const lanIp of [LAN_IP_WEB, LAN_IP_NAS]) expect(vpn).not.toContain(lanIp);

    // …and the addresses that DO belong are present, so the assertion above
    // cannot pass by rendering nothing at all.
    expect(office).toContain(LAN_IP_WEB);
    expect(vpn).toContain(MESH_IP_WEB);
  });

  test("the expected IP is the view's own answer, per service", () => {
    const manifest = renderProbes(registry);
    expect(section(manifest, "office").checks).toContainEqual({
      service: "grafana",
      check: "dns-answer",
      dnsName: "grafana.acme.test",
      expectIp: LAN_IP_WEB,
    });
    expect(section(manifest, "vpn").checks).toContainEqual({
      service: "grafana",
      check: "dns-answer",
      dnsName: "grafana.acme.test",
      expectIp: MESH_IP_WEB,
    });
  });
});

describe("probes manifest — check derivation", () => {
  test("dnsName alone yields the dns-answer check only", () => {
    const portal = section(renderProbes(registry), "vpn").checks.filter(
      (check) => check.service === "portal",
    );
    expect(portal.map((check) => check.check)).toEqual(["dns-answer"]);
  });

  test("a port adds tcp-connect; http adds http-status with concrete path and status", () => {
    const checks = section(renderProbes(registry), "office").checks;
    expect(checks.filter((check) => check.service === "grafana").map((check) => check.check)).toEqual(
      ["dns-answer", "http-status", "tcp-connect"],
    );
    expect(checks).toContainEqual({
      service: "grafana",
      check: "http-status",
      address: LAN_IP_WEB,
      port: 3000,
      dnsName: "grafana.acme.test",
      path: "/health",
      expectStatus: 204,
    });
    // An `http: {}` block renders the defaults, so the exporter carries none.
    expect(checks).toContainEqual({
      service: "nas-ui",
      check: "http-status",
      address: LAN_IP_NAS,
      port: 80,
      dnsName: "nas.acme.test",
      path: "/",
      expectStatus: 200,
    });
  });

  test("a service whose host does not exist is skipped, never given an invented address", () => {
    const dangling: Registry = {
      schemaVersion: 1,
      snapshots: {},
      hand: [
        { kind: "view", name: "vpn", scope: { kind: "mesh", mesh: "mesh-a" } },
        { kind: "service", name: "ghost", dnsName: "ghost.acme.test", host: "missing", port: 1 },
      ],
    };
    expect(section(renderProbes(dangling), "vpn").checks).toEqual([]);
  });
});

describe("probes manifest — determinism and registration", () => {
  const probes: Renderer = {
    name: "probes",
    render: (reg) => [{ path: "probes.json", value: renderProbes(reg) }],
  };

  test("two renders produce byte-identical files", () => {
    const first = buildFileSet(registry, "/out", [probes]);
    const second = buildFileSet(registry, "/out", [probes]);
    expect([...second]).toEqual([...first]);
  });

  test("check order does not depend on entity order in the registry", () => {
    const reversed: Registry = {
      ...registry,
      hand: [...registry.hand].reverse(),
    };
    expect(renderProbes(reversed)).toEqual(renderProbes(registry));
  });

  test("importing the registry pulls the probes renderer in", () => {
    // A fresh process: other test files reset the registry in-process, so
    // registration can only be proven where nothing has torn it down.
    const index = join(import.meta.dir, "..", "..", "src", "render", "index.ts");
    const proc = Bun.spawnSync([
      "bun",
      "-e",
      `import { renderers } from ${JSON.stringify(index)}; console.log(renderers().map((r) => r.name).join(","));`,
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim().split(",")).toContain("probes");
  });
});
