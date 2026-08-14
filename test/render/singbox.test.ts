import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildFileSet } from "../../src/commands/render.ts";
import { singboxRenderer, sortDnsRules } from "../../src/render/singbox.ts";
import { scopeToViews } from "../../src/lib/scope.ts";
import type { Registry } from "../../src/schema/registry.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const GOLDEN_DIR = join(import.meta.dir, "..", "..", "fixtures", "golden");

/**
 * Synthetic split-horizon fleet (no real CIDRs, names, or addresses):
 * - `panel-1` is dual-homed — mesh address and an org LAN address — so its
 *   service answers differently per view (the split-horizon essence);
 * - `store-1` is mesh-only, so org views must omit it;
 * - `orgnet-hq` is a view with zero service answers (the org gateway analog);
 * - `gw-site1` is the merged-gateway analog: site LAN answers first, mesh
 *   answers only for names the LAN does not serve. `panel` answers in both of
 *   its views, so it carries the exact `views` declaration integrity demands.
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
    {
      kind: "service",
      name: "panel",
      dnsName: "panel.acme.test",
      host: "panel-1",
      port: 443,
      views: ["orgnet-site1", "ownermesh"],
    },
    { kind: "service", name: "store", dnsName: "store.acme.test", host: "store-1", port: 8080 },
    { kind: "resolver", name: "gw-site1", views: ["orgnet-site1", "ownermesh"] },
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

  test("D12 file order: org-site-band views first, unallocated between, owner-subnet views last; merged files after", () => {
    const paths = singboxRenderer.render(registry).map((file) => file.path);
    expect(paths).toEqual([
      "singbox/dnsrules-orgnet-hq.json",
      "singbox/dnsrules-orgnet-site1.json",
      "singbox/dnsrules-ownermesh.json",
      "singbox/dnsrules-merged-gw-site1.json",
    ]);

    // Rank beats name: zz- (org-site-band) sorts first, aa- (owner-subnet) last, orphan between.
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
        { kind: "view", name: "zz-org", scope: { kind: "network", network: "zz-net" } },
        { kind: "view", name: "aa-owner", scope: { kind: "network", network: "aa-net" } },
        { kind: "view", name: "mm-orphan", scope: { kind: "network", network: "mm-net" } },
      ],
    };
    expect(singboxRenderer.render(ranked).map((file) => file.path)).toEqual([
      "singbox/dnsrules-zz-org.json",
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

  test("a resolver with all views scoped out is another org's — skipped, not an error", () => {
    // The real shape of the case: an org scopes the merged fleet envelope to
    // its own views. Its own view still answers (so the collapse guard stays
    // out of the picture); the other org's resolver must vanish, not throw.
    const foreign: Registry = {
      ...registry,
      hand: [
        ...registry.hand,
        { kind: "host", name: "kiosk-1", networks: { "orgnet-hq-lan": { ip: "198.51.100.7" } } },
        { kind: "service", name: "kiosk", dnsName: "kiosk.acme.test", host: "kiosk-1" },
      ],
    };
    const scoped = scopeToViews(foreign, ["orgnet-hq"]);
    const paths = singboxRenderer.render(scoped).map((file) => file.path);
    expect(paths).toEqual(["singbox/dnsrules-orgnet-hq.json"]);
  });

  test("a resolver with only PART of its views scoped in refuses — a truncated precedence list changes answers", () => {
    const scoped = scopeToViews(registry, ["orgnet-hq", "orgnet-site1"]);
    expect(() => singboxRenderer.render(scoped)).toThrow(
      /resolver "gw-site1" lost view\(s\) ownermesh/,
    );
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

describe("singbox merged render (per-gateway view precedence, computed in the engine)", () => {
  const merged = (): { dnsRules: { domain: string[]; answer: string[] }[] } =>
    JSON.parse(rendered().get("/out/singbox/dnsrules-merged-gw-site1.json") as string);

  test("golden: dnsrules-merged-gw-site1.json matches the committed golden byte-for-byte", async () => {
    const golden = await readFile(join(GOLDEN_DIR, "singbox-merged-gw-site1.json"), "utf8");
    expect(rendered().get("/out/singbox/dnsrules-merged-gw-site1.json")).toBe(golden);
  });

  test("a name answering in several views takes the FIRST listed view's answer", () => {
    const panel = merged().dnsRules.filter((rule) => rule.domain[0] === "panel.acme.test");
    expect(panel).toHaveLength(1); // one rule per name — the shadowed mesh answer is never emitted
    expect(panel[0]!.answer).toEqual(["panel.acme.test. IN A 192.0.2.10"]);
  });

  test("a name the first view does not serve falls to the next listed view", () => {
    const store = merged().dnsRules.filter((rule) => rule.domain[0] === "store.acme.test");
    expect(store).toHaveLength(1);
    expect(store[0]!.answer).toEqual(["store.acme.test. IN A 10.20.1.6"]);
  });

  test("a resolver whose views answer nothing renders a valid empty list", () => {
    const empty: Registry = {
      ...registry,
      hand: [
        ...registry.hand.filter((entity) => entity.kind !== "resolver"),
        { kind: "resolver", name: "gw-hq", views: ["orgnet-hq"] },
      ],
    };
    const files = new Map(singboxRenderer.render(empty).map((file) => [file.path, file.value]));
    expect(files.get("singbox/dnsrules-merged-gw-hq.json")).toEqual({ dnsRules: [] });
  });

  test("the merged list is sorted as ONE list — exact rules stay ahead of suffix rules across view boundaries", () => {
    // The per-file invariant (exact before suffix) must hold for the merged
    // union too: a suffix rule contributed by the first view must not swallow
    // an exact name contributed by the second (review #13's concatenation
    // hazard). v1 emits exact rules only, so prove it at the sort seam.
    const fromFirstView = { domain_suffix: [".acme.test"], action: "route", server: "site-dns" };
    const fromSecondView = {
      domain: ["store.acme.test"],
      action: "predefined",
      answer: ["store.acme.test. IN A 10.20.1.6"],
    };
    expect(sortDnsRules([fromFirstView, fromSecondView])).toEqual([fromSecondView, fromFirstView]);
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
