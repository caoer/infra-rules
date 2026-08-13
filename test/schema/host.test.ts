import { describe, expect, test } from "bun:test";
import { HostSchema } from "../../src/schema/host.ts";

const base = {
  kind: "host",
  name: "alpha",
  mesh: "lab-mesh",
  easytier_ip: "10.99.1.10",
  networks: { "lab-lan": { ip: "192.0.2.10" } },
} as const;

describe("HostSchema", () => {
  test("happy path", () => {
    const host = HostSchema.parse(base);
    expect(host.name).toBe("alpha");
    expect(host.easytier_ip).toBe("10.99.1.10");
  });

  test("address-free host is valid (shape puts no floor on membership)", () => {
    expect(HostSchema.safeParse({ kind: "host", name: "bare" }).success).toBe(true);
  });

  test("easytier_ip must be a valid IPv4 address", () => {
    expect(HostSchema.safeParse({ ...base, easytier_ip: "not-an-ip" }).success).toBe(false);
  });

  test("region allowed on jumper and exit hosts", () => {
    expect(HostSchema.safeParse({ ...base, roles: ["jumper"], region: "syd" }).success).toBe(true);
    expect(HostSchema.safeParse({ ...base, roles: ["exit"], region: "fra" }).success).toBe(true);
  });

  test("region rejected on a host that is neither jumper nor exit", () => {
    const result = HostSchema.safeParse({ ...base, region: "syd" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "region")).toBe(true);
    }
    expect(HostSchema.safeParse({ ...base, roles: ["gateway"], region: "syd" }).success).toBe(false);
  });

  test("unknown keys rejected (strict — field drift fails loud)", () => {
    expect(HostSchema.safeParse({ ...base, et_ip: "10.99.1.10" }).success).toBe(false);
  });
});
