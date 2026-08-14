import { describe, expect, test } from "bun:test";
import { RouteTargetSchema } from "../../src/schema/route-target.ts";

const base = {
  kind: "routeTarget",
  name: "gw-lab",
  resolver: "gw-lab",
  memberOf: { "lab-mesh": "direct" },
  policyOutbounds: { "site-a": "site-a" },
};

describe("RouteTargetSchema", () => {
  test("happy path — membership is a mesh→outbound record", () => {
    const parsed = RouteTargetSchema.parse(base);
    expect(parsed.memberOf["lab-mesh"]).toBe("direct");
  });

  test("empty records are legal — a member of nothing is a declared state", () => {
    expect(
      RouteTargetSchema.parse({ ...base, memberOf: {}, policyOutbounds: {} }).memberOf,
    ).toEqual({});
  });

  test("memberOf and policyOutbounds are required, never defaulted", () => {
    const { memberOf, ...withoutMemberOf } = base;
    const { policyOutbounds, ...withoutPolicies } = base;
    expect(RouteTargetSchema.safeParse(withoutMemberOf).success).toBe(false);
    expect(RouteTargetSchema.safeParse(withoutPolicies).success).toBe(false);
  });

  test("resolver anchor is required and non-empty", () => {
    const { resolver, ...withoutResolver } = base;
    expect(RouteTargetSchema.safeParse(withoutResolver).success).toBe(false);
    expect(RouteTargetSchema.safeParse({ ...base, resolver: "" }).success).toBe(false);
  });

  test("empty mapping values refuse — an outbound tag cannot be blank", () => {
    expect(RouteTargetSchema.safeParse({ ...base, memberOf: { "lab-mesh": "" } }).success).toBe(
      false,
    );
  });

  test("unknown keys refuse (strict object)", () => {
    expect(RouteTargetSchema.safeParse({ ...base, member: true }).success).toBe(false);
  });
});
