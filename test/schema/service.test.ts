import { describe, expect, test } from "bun:test";
import { ServiceSchema } from "../../src/schema/service.ts";

describe("ServiceSchema", () => {
  test("happy path", () => {
    const svc = ServiceSchema.parse({
      kind: "service",
      name: "wiki",
      dnsName: "wiki.lab.example",
      host: "alpha",
      port: 8080,
      http: { path: "/health", expectStatus: 200 },
    });
    expect(svc.dnsName).toBe("wiki.lab.example");
  });

  test("port and http are optional (dns-answer check alone is a valid service)", () => {
    expect(
      ServiceSchema.safeParse({
        kind: "service",
        name: "name-only",
        dnsName: "names.lab.example",
        host: "alpha",
      }).success,
    ).toBe(true);
  });

  test("port bounds enforced", () => {
    const base = { kind: "service", name: "s", dnsName: "s.lab.example", host: "alpha" };
    expect(ServiceSchema.safeParse({ ...base, port: 0 }).success).toBe(false);
    expect(ServiceSchema.safeParse({ ...base, port: 65536 }).success).toBe(false);
  });

  test("dnsName must be a hostname, not free text", () => {
    expect(
      ServiceSchema.safeParse({
        kind: "service",
        name: "s",
        dnsName: "not a hostname",
        host: "alpha",
      }).success,
    ).toBe(false);
  });
});
