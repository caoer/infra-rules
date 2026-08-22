import { describe, expect, test } from "bun:test";
import { ServiceSchema, isHostService } from "../../src/schema/service.ts";

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

describe("ServiceSchema — static answers (public entry points)", () => {
  const base = { kind: "service", name: "entry", dnsName: "entry.lab.example" };

  test("an A answer and a CNAME answer parse without a host", () => {
    expect(ServiceSchema.safeParse({ ...base, answer: { type: "A", value: "203.0.113.7" } }).success).toBe(true);
    expect(
      ServiceSchema.safeParse({ ...base, answer: { type: "CNAME", value: "gw.upstream.example" } }).success,
    ).toBe(true);
  });

  test("the value is typed by the record type", () => {
    expect(ServiceSchema.safeParse({ ...base, answer: { type: "A", value: "gw.upstream.example" } }).success).toBe(false);
    expect(ServiceSchema.safeParse({ ...base, answer: { type: "CNAME", value: "not a host" } }).success).toBe(false);
    expect(ServiceSchema.safeParse({ ...base, answer: { type: "TXT", value: "x" } }).success).toBe(false);
  });

  test("exactly one of host / answer — neither and both are refused", () => {
    expect(ServiceSchema.safeParse(base).success).toBe(false);
    expect(
      ServiceSchema.safeParse({ ...base, host: "alpha", answer: { type: "A", value: "203.0.113.7" } }).success,
    ).toBe(false);
  });

  test("port/http belong to a host; a static answer refuses them", () => {
    expect(
      ServiceSchema.safeParse({ ...base, answer: { type: "A", value: "203.0.113.7" }, port: 443 }).success,
    ).toBe(false);
  });

  test("isHostService narrows the two forms", () => {
    expect(isHostService(ServiceSchema.parse({ ...base, host: "alpha" }))).toBe(true);
    expect(isHostService(ServiceSchema.parse({ ...base, answer: { type: "A", value: "203.0.113.7" } }))).toBe(false);
  });
});
