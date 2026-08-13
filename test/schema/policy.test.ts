import { describe, expect, test } from "bun:test";
import { PolicySchema } from "../../src/schema/policy.ts";

describe("PolicySchema", () => {
  test("happy path", () => {
    expect(
      PolicySchema.parse({ kind: "policy", name: "M_lab", description: "synthetic" }).name,
    ).toBe("M_lab");
  });

  test("name required and non-empty", () => {
    expect(PolicySchema.safeParse({ kind: "policy", name: "" }).success).toBe(false);
    expect(PolicySchema.safeParse({ kind: "policy" }).success).toBe(false);
  });
});
