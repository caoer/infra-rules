/**
 * Output scoping — the guard against cross-org artifact leakage.
 *
 * Input is deliberately cross-org (D4's global uniqueness needs it); output
 * into a per-org repo never may be. These tests pin the two properties that
 * make the guard trustworthy: it actually narrows every renderer's output,
 * and an unknown view name fails LOUD rather than rendering nothing — because
 * a legitimately empty render and a wrong-org render look identical on disk.
 */
import { describe, expect, test } from "bun:test";
import { scopeToViews, UnknownViewError } from "../src/lib/scope.ts";
import type { Registry } from "../src/schema/registry.ts";

const registry: Registry = {
  schemaVersion: 1,
  snapshots: {
    zt: [
      { kind: "view", name: "owner-view", scope: { kind: "mesh", mesh: "owner-mesh" } },
      { kind: "host", name: "edge-1", mesh: "owner-mesh", easytier_ip: "10.99.0.1" },
    ],
  },
  hand: [{ kind: "view", name: "org-view", scope: { kind: "mesh", mesh: "orgnet" } }],
};

const viewNames = (reg: Registry): string[] =>
  [...Object.values(reg.snapshots).flat(), ...reg.hand]
    .filter((e) => e.kind === "view")
    .map((e) => e.name)
    .sort();

describe("scopeToViews", () => {
  test("narrows views across both sections, keeping non-view entities", () => {
    const scoped = scopeToViews(registry, ["owner-view"]);
    expect(viewNames(scoped)).toEqual(["owner-view"]);
    expect(scoped.snapshots.zt!.some((e) => e.kind === "host")).toBe(true);
  });

  test("an unknown view name throws, listing what is known", () => {
    expect(() => scopeToViews(registry, ["owner-view", "typo"])).toThrow(UnknownViewError);
    expect(() => scopeToViews(registry, ["typo"])).toThrow(/known views: org-view, owner-view/);
  });

  test("scoping to another org's view yields none of this org's views", () => {
    expect(viewNames(scopeToViews(registry, ["org-view"]))).toEqual(["org-view"]);
  });

  test("the input registry is not mutated", () => {
    scopeToViews(registry, ["owner-view"]);
    expect(viewNames(registry)).toEqual(["org-view", "owner-view"]);
  });
});
