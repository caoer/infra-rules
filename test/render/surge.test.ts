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

  test("routing entries not named by the layout do not render", async () => {
    const { registry, layout } = await loadInputs();
    const { text } = renderSurge(registry, layout);
    expect(text).not.toContain("10.99.5.0/24"); // decoy-neighbor
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

  test("layout naming a missing catch-all throws", async () => {
    const { registry, layout } = await loadInputs();
    const bad = { ...layout, catchAlls: ["core-band", "no-such-entry"] };
    expect(() => renderSurge(registry, bad)).toThrow(/catch-all "no-such-entry"/);
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
      catchAlls: ["core-band"],
    };
    expect(SurgeLayoutSchema.safeParse(base).success).toBe(false); // jumper doubles as spare
    expect(
      SurgeLayoutSchema.safeParse({ ...base, spares: [], regionOrder: ["east", "west"] }).success,
    ).toBe(false); // west has no jumper
    expect(SurgeLayoutSchema.safeParse({ ...base, spares: [] }).success).toBe(true);
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
      expect(stderr).toContain("4 proxies, 5 pins in 2 regions");
      const { registry, layout } = await loadInputs();
      expect(await readFile(out, "utf8")).toBe(renderSurge(registry, layout).text);
    } finally {
      await rm(out, { force: true });
    }
  });
});
