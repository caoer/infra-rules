import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildFileSet } from "../../src/commands/render.ts";
import { singboxRenderer, sortDnsRules } from "../../src/render/singbox.ts";
import type { Registry } from "../../src/schema/registry.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const GOLDEN_DIR = join(import.meta.dir, "..", "..", "fixtures", "golden");

/**
 * Synthetic split-horizon fleet (no real CIDRs, names, or addresses):
 * - `panel-1` is dual-homed — mesh address and a cos LAN address — so its
 *   service answers differently per view (the split-horizon essence);
 * - `store-1` is mesh-only, so cos views must omit it;
 * - `orgnet-hq` is a view with zero service answers (the org-hq-gw analog).
 */
const registry: Registry = {
  schemaVersion: 1,
  snapshots: {
    orgnet: [
      {
        kind: "network",
        name: "orgnet-site1-lan",
        cidr: "192.0.2.0/24",
        allocation: { vocabulary: "org-site-band", org: "orgnet", site: "site1", band: 1 },
      },
      {
        kind: "network",
        name: "orgnet-hq-lan",
        cidr: "198.51.100.0/24",
        allocation: { vocabulary: "org-site-band", org: "orgnet", site: "hq", band: 2 },
      },
    ],
  },
  hand: [
    {
      kind: "mesh",
      name: "lab-mesh",
      cidr: "10.20.0.0/14",
      allocation: { vocabulary: "owner-subnet", owner: "zt-lab", subnet: "10.20.0.0/14" },
    },
    {
      kind: "host",
      name: "panel-1",
      mesh: "lab-mesh",
      easytier_ip: "10.20.1.5",
      networks: { "orgnet-site1-lan": { ip: "192.0.2.10" } },
    },
    { kind: "host", name: "store-1", mesh: "lab-mesh", easytier_ip: "10.20.1.6" },
    { kind: "view", name: "orgnet-site1", scope: { kind: "network", network: "orgnet-site1-lan" } },
    { kind: "view", name: "orgnet-hq", scope: { kind: "network", network: "orgnet-hq-lan" } },
    { kind: "view", name: "ownermesh", scope: { kind: "mesh", mesh: "lab-mesh" } },
    { kind: "service", name: "panel", dnsName: "panel.acme.test", host: "panel-1", port: 443 },
    { kind: "service", name: "store", dnsName: "store.acme.test", host: "store-1", port: 8080 },
  ],
};

function rendered(): Map<string, string> {
  return buildFileSet(registry, "/out", [singboxRenderer]);
}

describe("singbox dnsRules renderer", () => {
  test.each(["orgnet-hq", "orgnet-site1", "ownermesh"])(
    "golden: dnsrules-%s.json matches the committed golden byte-for-byte",
    async (view) => {
      const golden = await readFile(join(GOLDEN_DIR, `singbox-${view}.json`), "utf8");
      expect(rendered().get(`/out/singbox/dnsrules-${view}.json`)).toBe(golden);
    },
  );

  test("a zero-service view renders a valid empty list, never null", () => {
    const contents = rendered().get("/out/singbox/dnsrules-orgnet-hq.json");
    const parsed = JSON.parse(contents as string) as { dnsRules: unknown };
    expect(Array.isArray(parsed.dnsRules)).toBe(true);
    expect(parsed.dnsRules).toEqual([]);
  });

  test("answers are per-view: LAN view gets the LAN address, mesh view the mesh address", () => {
    const files = rendered();
    const site1 = files.get("/out/singbox/dnsrules-orgnet-site1.json") as string;
    const mesh = files.get("/out/singbox/dnsrules-ownermesh.json") as string;
    expect(site1).toContain("panel.acme.test. IN A 192.0.2.10");
    expect(site1).not.toContain("10.20.1.5"); // mesh IP never leaks into the LAN view
    expect(mesh).toContain("panel.acme.test. IN A 10.20.1.5");
  });

  test("a host with no address in the view is omitted, not borrowed", () => {
    const site1 = rendered().get("/out/singbox/dnsrules-orgnet-site1.json") as string;
    expect(site1).not.toContain("store.acme.test");
  });

  test("D12 file order: cos views first, unallocated between, owner-mesh views last", () => {
    const paths = singboxRenderer.render(registry).map((file) => file.path);
    expect(paths).toEqual([
      "singbox/dnsrules-orgnet-hq.json",
      "singbox/dnsrules-orgnet-site1.json",
      "singbox/dnsrules-ownermesh.json",
    ]);

    // Rank beats name: zz- (cos) sorts first, aa- (owner-mesh) last, orphan between.
    const ranked: Registry = {
      schemaVersion: 1,
      snapshots: {},
      hand: [
        {
          kind: "network",
          name: "zz-net",
          cidr: "192.0.2.0/25",
          allocation: { vocabulary: "org-site-band", org: "orgnet", site: "zz" },
        },
        {
          kind: "network",
          name: "aa-net",
          cidr: "198.51.100.0/25",
          allocation: { vocabulary: "owner-subnet", owner: "zt-lab", subnet: "198.51.100.0/25" },
        },
        { kind: "network", name: "mm-net", cidr: "203.0.113.0/25" },
        { kind: "view", name: "zz-cos", scope: { kind: "network", network: "zz-net" } },
        { kind: "view", name: "aa-owner", scope: { kind: "network", network: "aa-net" } },
        { kind: "view", name: "mm-orphan", scope: { kind: "network", network: "mm-net" } },
      ],
    };
    expect(singboxRenderer.render(ranked).map((file) => file.path)).toEqual([
      "singbox/dnsrules-zz-cos.json",
      "singbox/dnsrules-mm-orphan.json",
      "singbox/dnsrules-aa-owner.json",
    ]);
  });

  test("exact domain rules sort before domain_suffix rules (first-match safety)", () => {
    const suffix = { domain_suffix: [".acme.test"], action: "route", server: "lab-dns" };
    const exactA = { domain: ["a.acme.test"], action: "predefined", answer: ["a.acme.test. IN A 192.0.2.1"] };
    const exactB = { domain: ["b.acme.test"], action: "predefined", answer: ["b.acme.test. IN A 192.0.2.2"] };
    expect(sortDnsRules([suffix, exactB, exactA])).toEqual([exactA, exactB, suffix]);
  });

  test("rendered rules are exact-sorted by name", () => {
    const mesh = rendered().get("/out/singbox/dnsrules-ownermesh.json") as string;
    const parsed = JSON.parse(mesh) as { dnsRules: { domain: string[] }[] };
    expect(parsed.dnsRules.map((rule) => rule.domain[0])).toEqual([
      "panel.acme.test",
      "store.acme.test",
    ]);
  });

  test("a service referencing a missing host fails the render loudly", () => {
    const broken: Registry = {
      schemaVersion: 1,
      snapshots: {},
      hand: [
        { kind: "view", name: "ownermesh", scope: { kind: "mesh", mesh: "lab-mesh" } },
        { kind: "service", name: "ghost", dnsName: "ghost.acme.test", host: "ghost-1" },
      ],
    };
    expect(() => singboxRenderer.render(broken)).toThrow(/missing host "ghost-1"/);
  });
});

describe("singbox registration (fresh process — immune to in-process registry resets)", () => {
  let dir: string;

  beforeEach(async () => {
    await mkdir(join(import.meta.dir, "..", ".tmp"), { recursive: true });
    dir = await mkdtemp(join(import.meta.dir, "..", ".tmp", "singbox-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the registrations one-liner makes `render` emit the singbox files", async () => {
    const registryPath = join(dir, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry));
    const proc = Bun.spawn(["bun", CLI, "render", "--registry", registryPath, "--out", join(dir, "out")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const golden = await readFile(join(GOLDEN_DIR, "singbox-ownermesh.json"), "utf8");
    const written = await readFile(join(dir, "out", "singbox", "dnsrules-ownermesh.json"), "utf8");
    expect(written).toBe(golden);
  });
});
