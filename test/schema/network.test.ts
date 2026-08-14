import { describe, expect, test } from "bun:test";
import { AllocationSchema, NetworkSchema } from "../../src/schema/network.ts";

describe("NetworkSchema", () => {
  test("happy path", () => {
    const net = NetworkSchema.parse({
      kind: "network",
      name: "lab-lan",
      cidr: "192.0.2.0/24",
      description: "synthetic fixture network",
    });
    expect(net.cidr).toBe("192.0.2.0/24");
  });

  test("10.99.14.0/24 validates (outside any supernet — shape does no CIDR math)", () => {
    const result = NetworkSchema.safeParse({
      kind: "network",
      name: "outlier",
      cidr: "10.99.14.0/24",
    });
    expect(result.success).toBe(true);
  });

  test("malformed cidr rejected", () => {
    expect(
      NetworkSchema.safeParse({ kind: "network", name: "bad", cidr: "192.0.2.0/33" }).success,
    ).toBe(false);
  });
});

describe("AllocationSchema — dual vocabularies, never conflated", () => {
  test("org-site-band parses", () => {
    expect(
      AllocationSchema.safeParse({
        vocabulary: "org-site-band",
        org: "acme",
        site: "hq",
        band: 7,
      }).success,
    ).toBe(true);
  });

  test("owner-subnet parses", () => {
    expect(
      AllocationSchema.safeParse({
        vocabulary: "owner-subnet",
        owner: "zed",
        subnet: "10.99.7.0/24",
      }).success,
    ).toBe(true);
  });

  test("mixing vocabularies is not representable", () => {
    expect(
      AllocationSchema.safeParse({
        vocabulary: "org-site-band",
        org: "acme",
        site: "hq",
        subnet: "10.99.7.0/24",
      }).success,
    ).toBe(false);
    expect(
      AllocationSchema.safeParse({
        vocabulary: "owner-subnet",
        owner: "zed",
        subnet: "10.99.7.0/24",
        site: "hq",
      }).success,
    ).toBe(false);
  });

  test("an allocation without a vocabulary discriminant is rejected", () => {
    expect(AllocationSchema.safeParse({ org: "acme", site: "hq" }).success).toBe(false);
  });
});
