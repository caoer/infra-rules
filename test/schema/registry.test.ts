import { describe, expect, test } from "bun:test";
import { EntitySchema, RegistrySchema, SCHEMA_VERSION } from "../../src/schema/registry.ts";

const entities = [
  { kind: "host", name: "alpha", mesh: "lab-mesh", easytier_ip: "10.99.1.10" },
  { kind: "network", name: "lab-lan", cidr: "192.0.2.0/24" },
  { kind: "mesh", name: "lab-mesh", cidr: "10.99.0.0/16" },
  { kind: "view", name: "lab-mesh-view", scope: { kind: "mesh", mesh: "lab-mesh" } },
  { kind: "policy", name: "M_lab" },
  { kind: "service", name: "wiki", dnsName: "wiki.lab.example", host: "alpha", port: 8080 },
  {
    kind: "routing",
    entry: "intent",
    name: "lab-range",
    match: { match: "cidr", cidr: "10.99.0.0/16" },
    policy: "M_lab",
    priority: 100,
  },
  { kind: "routing", entry: "catch-all", name: "final", policy: "DIRECT", priority: 0 },
  {
    kind: "proxyExit",
    name: "exit-fixture",
    host: "203.0.113.9",
    port: 8388,
    method: "aes-128-gcm",
    password: "fixture-not-a-real-secret",
  },
];

describe("EntitySchema", () => {
  test("every entity kind parses through the union", () => {
    for (const entity of entities) {
      const result = EntitySchema.safeParse(entity);
      expect(result.success).toBe(true);
    }
  });

  test("unknown kind rejected", () => {
    expect(EntitySchema.safeParse({ kind: "gadget", name: "x" }).success).toBe(false);
  });
});

describe("RegistrySchema — envelope", () => {
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    snapshots: { "org-a": entities.slice(0, 3), "org-b": [] },
    hand: entities.slice(3),
  };

  test("happy path: snapshots keyed by org + hand section", () => {
    const registry = RegistrySchema.parse(envelope);
    expect(Object.keys(registry.snapshots)).toEqual(["org-a", "org-b"]);
    expect(registry.hand).toHaveLength(entities.length - 3);
  });

  test("schemaVersion is pinned: a different version is a parse error", () => {
    expect(RegistrySchema.safeParse({ ...envelope, schemaVersion: 2 }).success).toBe(false);
  });

  test("schemaVersion is required from day one", () => {
    const { schemaVersion: _omitted, ...rest } = envelope;
    expect(RegistrySchema.safeParse(rest).success).toBe(false);
  });

  test("sections are mandatory — an envelope without hand/snapshots is invalid", () => {
    expect(
      RegistrySchema.safeParse({ schemaVersion: SCHEMA_VERSION, hand: [] }).success,
    ).toBe(false);
    expect(
      RegistrySchema.safeParse({ schemaVersion: SCHEMA_VERSION, snapshots: {} }).success,
    ).toBe(false);
  });
});
