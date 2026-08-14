import { describe, expect, test } from "bun:test";

import { routerulesRenderer } from "../../src/render/routerules.ts";
import { scopeToViews } from "../../src/lib/scope.ts";
import type { Registry } from "../../src/schema/registry.ts";

/**
 * Synthetic fleet exercising both of the ruling's node classes: `gw-inside`
 * is a MEMBER of lab-mesh (routes its space over its own path), `gw-outside`
 * is a member of nothing (every range detours through its proxy outbounds).
 * Ranges: lab-mesh 10.20.0.0/14 with two site ranges inside it, one LAN site
 * outside any mesh, one domain intent (never rendered here), one catch-all
 * (never rendered here).
 */
const registry: Registry = {
  schemaVersion: 1,
  snapshots: {},
  hand: [
    {
      kind: "mesh",
      name: "lab-mesh",
      cidr: "10.20.0.0/14",
      allocation: { vocabulary: "owner-subnet", owner: "zt-lab", subnet: "10.20.0.0/14" },
    },
    { kind: "policy", name: "mesh" },
    { kind: "policy", name: "site-a" },
    { kind: "view", name: "lab-view", scope: { kind: "mesh", mesh: "lab-mesh" } },
    { kind: "view", name: "away-view", scope: { kind: "mesh", mesh: "lab-mesh" } },
    { kind: "resolver", name: "gw-inside", views: ["lab-view"] },
    { kind: "resolver", name: "gw-outside", views: ["away-view"] },
    {
      kind: "routing",
      entry: "intent",
      name: "site-a-range",
      priority: 10,
      match: { match: "cidr", cidr: "10.20.2.0/24" },
      mesh: "lab-mesh",
      policy: "site-a",
    },
    {
      kind: "routing",
      entry: "intent",
      name: "lab-space",
      priority: 20,
      match: { match: "cidr", cidr: "10.20.0.0/14" },
      mesh: "lab-mesh",
      policy: "mesh",
    },
    {
      kind: "routing",
      entry: "intent",
      name: "site-a-lan",
      priority: 30,
      match: { match: "cidr", cidr: "198.51.100.0/25" },
      policy: "site-a",
    },
    {
      kind: "routing",
      entry: "intent",
      name: "site-a-names",
      priority: 5,
      match: { match: "domain-suffix", suffix: "svc.acme.test" },
      policy: "site-a",
    },
    {
      kind: "routing",
      entry: "catch-all",
      name: "lab-floor",
      priority: 100,
      match: { match: "cidr", cidr: "10.16.0.0/12" },
      policy: "mesh",
    },
    {
      kind: "routeTarget",
      name: "gw-inside",
      resolver: "gw-inside",
      memberOf: { "lab-mesh": "direct" },
      policyOutbounds: { "site-a": "site-a" },
    },
    {
      kind: "routeTarget",
      name: "gw-outside",
      resolver: "gw-outside",
      memberOf: {},
      policyOutbounds: { "site-a": "site-a", mesh: "mesh-detour" },
    },
  ],
};

const render = (r: Registry) => routerulesRenderer.render(r);

const fileFor = (r: Registry, name: string) => {
  const file = render(r).find((f) => f.path === `singbox/routerules-${name}.json`);
  if (file === undefined) throw new Error(`no routerules file for ${name}`);
  return file.value as { routeRules: { ip_cidr: string[]; action: string; outbound: string }[] };
};

describe("routerules renderer — membership resolution", () => {
  test("a member routes its mesh's ranges over the member path; everything else detours", () => {
    const { routeRules } = fileFor(registry, "gw-inside");
    expect(routeRules).toEqual([
      // orderRouting: priority ascending; domain intent (prio 5) is not here
      { ip_cidr: ["10.20.2.0/24"], action: "route", outbound: "direct" },
      { ip_cidr: ["10.20.0.0/14"], action: "route", outbound: "direct" },
      { ip_cidr: ["198.51.100.0/25"], action: "route", outbound: "site-a" },
    ]);
  });

  test("a non-member resolves every range through its policy outbounds", () => {
    const { routeRules } = fileFor(registry, "gw-outside");
    expect(routeRules).toEqual([
      { ip_cidr: ["10.20.2.0/24"], action: "route", outbound: "site-a" },
      { ip_cidr: ["10.20.0.0/14"], action: "route", outbound: "mesh-detour" },
      { ip_cidr: ["198.51.100.0/25"], action: "route", outbound: "site-a" },
    ]);
  });

  test("domain intents and catch-alls never render — the per-site contract is IP-shaped", () => {
    const files = render(registry);
    const bodies = JSON.stringify(files);
    expect(bodies).not.toContain("svc.acme.test");
    expect(bodies).not.toContain("10.16.0.0/12");
  });

  test("no routeTarget entities → no files", () => {
    const without: Registry = {
      ...registry,
      hand: registry.hand.filter((entity) => entity.kind !== "routeTarget"),
    };
    expect(render(without)).toEqual([]);
  });
});

describe("routerules renderer — loud failures", () => {
  test("a policy without a policyOutbounds mapping refuses", () => {
    const bare: Registry = {
      ...registry,
      hand: registry.hand.map((entity) =>
        entity.kind === "routeTarget" && entity.name === "gw-outside"
          ? { ...entity, policyOutbounds: { "site-a": "site-a" } } // drops the "mesh" mapping
          : entity,
      ),
    };
    expect(() => render(bare)).toThrow(/policyOutbounds has no mapping/);
  });

  test("a memberOf mesh no cidr intent declares refuses — a typo must not demote a member", () => {
    const typo: Registry = {
      ...registry,
      hand: registry.hand.map((entity) =>
        entity.kind === "routeTarget" && entity.name === "gw-inside"
          ? { ...entity, memberOf: { "lab-mssh": "direct" } }
          : entity,
      ),
    };
    expect(() => render(typo)).toThrow(/memberOf names mesh "lab-mssh"/);
  });

  test("routeTargets with zero cidr intents in the registry refuse — dead config", () => {
    const noIntents: Registry = {
      ...registry,
      hand: registry.hand.filter(
        (entity) => !(entity.kind === "routing" && entity.entry === "intent" && entity.match.match === "cidr"),
      ),
    };
    expect(() => render(noIntents)).toThrow(/no cidr routing intents/);
  });
});

describe("routerules renderer — output scoping (--views)", () => {
  test("a target whose resolver lost every view is another org's — skipped", () => {
    const scoped = scopeToViews(registry, ["lab-view"]);
    const files = render(scoped);
    expect(files.map((f) => f.path)).toEqual(["singbox/routerules-gw-inside.json"]);
  });

  test("a partially scoped resolver is a hard error, never a truncated render", () => {
    const twoViewed: Registry = {
      ...registry,
      hand: registry.hand.map((entity) =>
        entity.kind === "resolver" && entity.name === "gw-inside"
          ? { ...entity, views: ["lab-view", "away-view"] }
          : entity,
      ),
    };
    const scoped = scopeToViews(twoViewed, ["lab-view"]);
    expect(() => render(scoped)).toThrow(/lost view\(s\) away-view/);
  });
});
