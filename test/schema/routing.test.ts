import { describe, expect, test } from "bun:test";
import {
  RoutingCatchAllSchema,
  RoutingIntentSchema,
  RoutingSchema,
  orderRouting,
  type Routing,
} from "../../src/schema/routing.ts";

const intent = (name: string, priority: number): Routing =>
  RoutingIntentSchema.parse({
    kind: "routing",
    entry: "intent",
    name,
    match: { match: "cidr", cidr: "10.99.0.0/16" },
    policy: "M_lab",
    priority,
  });

const catchAll = (name: string, priority: number): Routing =>
  RoutingCatchAllSchema.parse({
    kind: "routing",
    entry: "catch-all",
    name,
    match: { match: "cidr", cidr: "10.96.0.0/12" },
    policy: "DIRECT",
    priority,
  });

describe("RoutingSchema", () => {
  test("happy path: intent with cidr, domain, and domain-suffix matches", () => {
    expect(intent("lab-mesh-range", 100).entry).toBe("intent");
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "intent",
        name: "one-name",
        match: { match: "domain", domain: "svc.lab.example" },
        policy: "M_lab",
        priority: 10,
      }).success,
    ).toBe(true);
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "intent",
        name: "suffix",
        match: { match: "domain-suffix", suffix: ".lab.example" },
        policy: "M_lab",
        priority: 20,
      }).success,
    ).toBe(true);
  });

  test("happy path: catch-all carries a cidr match (a covering range is still a rule)", () => {
    expect(catchAll("final", 0).entry).toBe("catch-all");
  });

  test("an intent without a priority is rejected — ordering is explicit data", () => {
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "intent",
        name: "no-priority",
        match: { match: "cidr", cidr: "10.99.0.0/16" },
        policy: "M_lab",
      }).success,
    ).toBe(false);
  });

  test("a catch-all without a match is rejected — a covering range must name its range", () => {
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "catch-all",
        name: "rangeless",
        policy: "DIRECT",
        priority: 0,
      }).success,
    ).toBe(false);
  });

  test("a catch-all with a domain-shaped match is rejected — no renderer can emit one", () => {
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "catch-all",
        name: "domainy",
        policy: "DIRECT",
        priority: 0,
        match: { match: "domain-suffix", suffix: ".lab.example" },
      }).success,
    ).toBe(false);
  });

  test("priority must be a non-negative integer", () => {
    expect(
      RoutingSchema.safeParse({
        kind: "routing",
        entry: "intent",
        name: "neg",
        match: { match: "cidr", cidr: "10.99.0.0/16" },
        policy: "M_lab",
        priority: -1,
      }).success,
    ).toBe(false);
  });
});

describe("orderRouting — emission order semantics", () => {
  test("intents sort by priority ascending (lower emits earlier)", () => {
    const ordered = orderRouting([intent("late", 200), intent("early", 10), intent("mid", 100)]);
    expect(ordered.map((e) => e.name)).toEqual(["early", "mid", "late"]);
  });

  test("catch-alls always emit last, whatever their priority", () => {
    const ordered = orderRouting([catchAll("final", 0), intent("specific", 999)]);
    expect(ordered.map((e) => e.name)).toEqual(["specific", "final"]);
  });

  test("catch-alls order among themselves by priority", () => {
    const ordered = orderRouting([catchAll("z-last", 20), catchAll("first", 10), intent("a", 5)]);
    expect(ordered.map((e) => e.name)).toEqual(["a", "first", "z-last"]);
  });

  test("equal priority breaks ties by name, deterministically", () => {
    const ordered = orderRouting([intent("bravo", 50), intent("alpha", 50)]);
    expect(ordered.map((e) => e.name)).toEqual(["alpha", "bravo"]);
  });

  test("input order never matters", () => {
    const a = orderRouting([intent("x", 30), catchAll("c", 0), intent("y", 20)]);
    const b = orderRouting([catchAll("c", 0), intent("y", 20), intent("x", 30)]);
    expect(a).toEqual(b);
  });
});
