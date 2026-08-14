import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadRegistry } from "../../src/commands/render.ts";
import {
  SurgeLayoutSchema,
  renderSurge,
  tier1Strip,
  type SurgeLayout,
} from "../../src/render/surge.ts";
import type { Registry } from "../../src/schema/registry.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "fixtures", "surge.json");
const LAYOUT = join(ROOT, "fixtures", "surge-layout.json");
const GOLDEN = join(ROOT, "fixtures", "golden", "surge.golden.dconf");

async function loadInputs(): Promise<{ registry: Registry; layout: SurgeLayout }> {
  const registry = await loadRegistry(FIXTURE);
  const layout = SurgeLayoutSchema.parse(JSON.parse(await readFile(LAYOUT, "utf8")));
  return { registry, layout };
}

describe("surge renderer — tier-1 (D19)", () => {
  test("stripped render is byte-identical to the committed golden", async () => {
    const { registry, layout } = await loadInputs();
    const { text } = renderSurge(registry, layout);
    const golden = await readFile(GOLDEN, "utf8");
    // Direct compare against the committed golden (D17) — the golden is
    // stored already-stripped, and tier1Strip is idempotent on stripped text.
    expect(tier1Strip(text)).toBe(golden);
    expect(tier1Strip(golden)).toBe(golden);
  });

  test("render is deterministic", async () => {
    const { registry, layout } = await loadInputs();
    expect(renderSurge(registry, layout).text).toBe(renderSurge(registry, layout).text);
  });

  test("stats match the fixture's shape", async () => {
    const { registry, layout } = await loadInputs();
    const { stats } = renderSurge(registry, layout);
    expect(stats).toEqual({
      proxies: 4,
      pins: 5,
      pinRegions: 2, // north has no pins — its block is skipped, its jumper stays
      unmapped: 3, // two regionless + one foreign-region host
      intents: 5,
      catchAlls: 3,
      hosts: 8,
    });
  });

  test("mesh-overlay hosts are excluded everywhere (byte-identity host set)", async () => {
    const { registry, layout } = await loadInputs();
    const { text } = renderSurge(registry, layout);
    expect(text).not.toContain("ghost-");
    expect(text).not.toContain("10.98.1.100");
    expect(text).not.toContain("10.98.2.150");
  });

  test("routing intents render in priority order, between the pins and the catch-alls", async () => {
    const { registry, layout } = await loadInputs();
    const { text } = renderSurge(registry, layout);
    const rules = text
      .split("\n")
      .filter((line) => /^(IP-CIDR|DOMAIN|DOMAIN-SUFFIX),/.test(line) && !line.includes("/32,"));
    expect(rules).toEqual([
      // intents, priority ascending — domains and ranges in one ordered pass
      "DOMAIN-SUFFIX,svc.acme.test,PG_site_a",
      "DOMAIN,portal.acme.test,PG_mesh",
      "IP-CIDR,198.51.100.0/25,PG_site_a,no-resolve",
      "IP-CIDR,10.99.5.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.98.32.0/24,PG_site_a,no-resolve", // mesh-space site, memberOf {} → policy detour
      // catch-alls, always last
      "IP-CIDR,10.98.1.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.20.14.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.98.0.0/17,PG_mesh,no-resolve",
    ]);
    // The intents block sits below the last /32 pin: pins are the most
    // specific overrides and must stay strongest.
    const lastPin = text.lastIndexOf("/32,");
    expect(text.indexOf("DOMAIN-SUFFIX,svc.acme.test")).toBeGreaterThan(lastPin);
  });

  test("membership engages: a memberOf mesh routes its declared ranges over the member path", async () => {
    const { registry, layout } = await loadInputs();
    const member: SurgeLayout = { ...layout, memberOf: { "test-mesh": "PG_direct" } };
    const { text } = renderSurge(registry, member);
    // site-a-range declares mesh "test-mesh" → member path wins over the policy…
    expect(text).toContain("IP-CIDR,10.98.32.0/24,PG_direct,no-resolve");
    // …while targets outside any mesh keep the policy detour (LAN site, domains).
    expect(text).toContain("IP-CIDR,198.51.100.0/25,PG_site_a,no-resolve");
    expect(text).toContain("DOMAIN-SUFFIX,svc.acme.test,PG_site_a");
  });

  test("always-last engages: an intent outranking every catch-all still cannot land below them", async () => {
    const { registry, layout } = await loadInputs();
    const outranking: Registry = {
      ...registry,
      hand: [
        ...registry.hand,
        {
          kind: "routing" as const,
          entry: "intent" as const,
          name: "outranker",
          priority: 999, // higher than every catch-all in the fixture (100/110/120)
          match: { match: "cidr" as const, cidr: "10.98.7.0/24" },
          policy: "mesh",
        },
      ],
    };
    const { text, stats } = renderSurge(outranking, layout);
    expect(stats.catchAlls).toBe(3);
    // The intent renders — but no priority value moves it into (or below) the
    // always-last pass. The render's last three IP-CIDR lines stay the catch-alls.
    const ruleLines = text.split("\n").filter((line) => line.startsWith("IP-CIDR,"));
    expect(ruleLines.at(-4)).toBe("IP-CIDR,10.98.7.0/24,PG_mesh,no-resolve");
    expect(ruleLines.slice(-3)).toEqual([
      "IP-CIDR,10.98.1.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.20.14.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.98.0.0/17,PG_mesh,no-resolve",
    ]);
  });

  test("catch-all cannot be shadowed: priority orders catch-alls only among themselves", async () => {
    const { registry, layout } = await loadInputs();
    // Drop core-band (10.98.1.0/24) to priority 0 — far below every intent.
    // It must still emit in the always-last block, and still ahead of the
    // /15 supernet that contains it (priority among catch-alls is nesting order).
    const reprioritized: Registry = {
      ...registry,
      hand: registry.hand.map((entity) =>
        entity.kind === "routing" && entity.name === "core-band"
          ? { ...entity, priority: 0 }
          : entity,
      ),
    };
    const { text } = renderSurge(reprioritized, layout);
    const ruleLines = text.split("\n").filter((line) => line.startsWith("IP-CIDR,"));
    expect(ruleLines.slice(-3)).toEqual([
      "IP-CIDR,10.98.1.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.20.14.0/24,PG_mesh,no-resolve",
      "IP-CIDR,10.98.0.0/17,PG_mesh,no-resolve",
    ]);
  });

  test("credentials appear in the full render but never survive the strip", async () => {
    const { registry, layout } = await loadInputs();
    const { text } = renderSurge(registry, layout);
    expect(text).toContain('password="fake-pw-east"');
    expect(tier1Strip(text)).not.toContain("password");
  });
});

describe("surge renderer — loud failures", () => {
  test("zero source-matched hosts throws instead of rendering empty", async () => {
    const { registry, layout } = await loadInputs();
    const noInventory: Registry = {
      ...registry,
      snapshots: {
        testorg: registry.snapshots["testorg"]!.map((entity) =>
          entity.kind === "host" ? { ...entity, source: "mesh-overlay" as const } : entity,
        ),
      },
    };
    expect(() => renderSurge(noInventory, layout)).toThrow(/empty render is never correct/);
  });

  test("layout naming a missing proxyExit throws", async () => {
    const { registry, layout } = await loadInputs();
    const bad = { ...layout, jumpers: { ...layout.jumpers, east: "exit-nowhere" } };
    expect(() => renderSurge(registry, bad)).toThrow(/proxyExit "exit-nowhere"/);
  });

  test("a proxyExit the layout does not assign throws (no silent drops)", async () => {
    const { registry, layout } = await loadInputs();
    const bad = { ...layout, spares: [] };
    expect(() => renderSurge(registry, bad)).toThrow(/not assigned by the layout: exit-west-2/);
  });

  test("a registry with no catch-all entries throws instead of rendering without a floor", async () => {
    const { registry, layout } = await loadInputs();
    const noCatchAlls: Registry = {
      ...registry,
      hand: registry.hand.filter(
        (entity) => !(entity.kind === "routing" && entity.entry === "catch-all"),
      ),
    };
    expect(() => renderSurge(noCatchAlls, layout)).toThrow(/no catch-all routing entries/);
  });

  test("a policy without a policyGroups mapping throws", async () => {
    const { registry, layout } = await loadInputs();
    const bad = { ...layout, policyGroups: { unrelated: "PG_x" } };
    expect(() => renderSurge(registry, bad)).toThrow(/policy "mesh" has no policyGroups mapping/);
  });

  test("layout schema rejects jumper/spare overlap and uncovered regions", () => {
    const base = {
      regionOrder: ["east"],
      jumpers: { east: "exit-east-1" },
      spares: ["exit-east-1"],
      proxyExtras: "tfo=true",
      hostSuffix: ".x.test",
      policyGroups: { mesh: "PG_mesh" },
      pinPolicy: "mesh",
      memberOf: {},
    };
    expect(SurgeLayoutSchema.safeParse(base).success).toBe(false); // jumper doubles as spare
    expect(
      SurgeLayoutSchema.safeParse({ ...base, spares: [], regionOrder: ["east", "west"] }).success,
    ).toBe(false); // west has no jumper
    expect(SurgeLayoutSchema.safeParse({ ...base, spares: [] }).success).toBe(true);
  });

  test("layout schema rejects the retired catchAlls key — membership is registry data now", () => {
    const withRetiredKey = {
      regionOrder: ["east"],
      jumpers: { east: "exit-east-1" },
      spares: [],
      proxyExtras: "tfo=true",
      hostSuffix: ".x.test",
      policyGroups: { mesh: "PG_mesh" },
      pinPolicy: "mesh",
      memberOf: {},
      catchAlls: ["core-band"],
    };
    const parsed = SurgeLayoutSchema.safeParse(withRetiredKey);
    expect(parsed.success).toBe(false); // strictObject refuses the leftover key, loud
  });

  test("two regions naming one jumper is a layout validate error, not a silent dedup (D4)", () => {
    const shared = {
      regionOrder: ["east", "west"],
      jumpers: { east: "exit-east-1", west: "exit-east-1" },
      spares: [],
      proxyExtras: "tfo=true",
      hostSuffix: ".x.test",
      policyGroups: { mesh: "PG_mesh" },
      pinPolicy: "mesh",
      memberOf: {},
    };
    const parsed = SurgeLayoutSchema.safeParse(shared);
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join("\n");
    expect(message).toContain('"east"'); // both sources named, per D4
    expect(message).toContain('"west"');
    expect(message).toContain('"exit-east-1"');
  });

  test("a spare listed twice is a layout validate error", () => {
    const doubled = {
      regionOrder: ["east"],
      jumpers: { east: "exit-east-1" },
      spares: ["exit-west-2", "exit-west-2"],
      proxyExtras: "tfo=true",
      hostSuffix: ".x.test",
      policyGroups: { mesh: "PG_mesh" },
      pinPolicy: "mesh",
      memberOf: {},
    };
    expect(SurgeLayoutSchema.safeParse(doubled).success).toBe(false);
  });
});

describe("surge renderer — CLI", () => {
  test("render-surge writes the artifact and reports counts", async () => {
    const out = join(ROOT, ".test-surge-out.dconf");
    try {
      const proc = Bun.spawn(
        ["bun", join(ROOT, "src", "cli.ts"), "render-surge", "--registry", FIXTURE, "--layout", LAYOUT, "--out", out],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain("4 proxies, 5 pins in 2 regions, 3 unmapped, 5 intents");
      const { registry, layout } = await loadInputs();
      expect(await readFile(out, "utf8")).toBe(renderSurge(registry, layout).text);
    } finally {
      await rm(out, { force: true });
    }
  });
});
