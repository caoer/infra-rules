import { describe, expect, test } from "bun:test";
import {
  canonicalCidr,
  cidrContainsIp,
  cidrsOverlap,
  hasHostBits,
  ipToUint32,
  maskForPrefix,
  parseCidr,
  uint32ToIp,
} from "../src/lib/cidr.ts";

// All ranges here are synthetic (10.20/14, 10.99/16, TEST-NETs) — never live fleet data.

describe("ipToUint32 / uint32ToIp", () => {
  test("round-trips the corners", () => {
    for (const ip of ["0.0.0.0", "255.255.255.255", "10.20.1.7", "192.0.2.1"]) {
      expect(uint32ToIp(ipToUint32(ip))).toBe(ip);
    }
  });

  test("rejects malformed input", () => {
    for (const bad of ["10.0.0", "10.0.0.0.0", "10.0.0.256", "10.0.0.01", "not-an-ip", ""]) {
      expect(() => ipToUint32(bad)).toThrow(TypeError);
    }
  });
});

describe("maskForPrefix", () => {
  test("/0 is all-pass, not a JS shift-count wrap", () => {
    expect(maskForPrefix(0)).toBe(0);
  });

  test("/32 is exact-host", () => {
    expect(maskForPrefix(32)).toBe(0xffffffff);
  });

  test("/14 masks octet bands, not octet edges", () => {
    expect(uint32ToIp(maskForPrefix(14))).toBe("255.252.0.0");
  });

  test("rejects out-of-range prefixes", () => {
    for (const bad of [-1, 33, 1.5, Number.NaN]) {
      expect(() => maskForPrefix(bad)).toThrow(TypeError);
    }
  });
});

describe("parseCidr", () => {
  test("keeps the written base and computes the network", () => {
    const parsed = parseCidr("10.20.1.7/14");
    expect(uint32ToIp(parsed.base)).toBe("10.20.1.7");
    expect(uint32ToIp(parsed.network)).toBe("10.20.0.0");
    expect(parsed.prefix).toBe(14);
  });

  test("rejects malformed notation", () => {
    for (const bad of ["10.0.0.0", "10.0.0.0/", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/08", "/24"]) {
      expect(() => parseCidr(bad)).toThrow(TypeError);
    }
  });
});

describe("cidrContainsIp — the D16 probe cases, now regression tests", () => {
  const cases: [string, string, boolean][] = [
    ["10.20.1.7", "10.20.0.0/14", true], // inside a /14 band (not octet-aligned)
    ["10.24.0.1", "10.20.0.0/14", false], // just past the /14 upper edge
    ["10.99.14.9", "10.99.14.0/24", true],
    ["10.99.15.9", "10.99.14.0/24", false],
  ];

  test.each(cases)("contains(%s ∈ %s) = %p", (ip, cidr, want) => {
    expect(cidrContainsIp(cidr, ip)).toBe(want);
  });

  test("/0 contains everything; /32 contains only itself", () => {
    expect(cidrContainsIp("0.0.0.0/0", "203.0.113.9")).toBe(true);
    expect(cidrContainsIp("10.99.1.10/32", "10.99.1.10")).toBe(true);
    expect(cidrContainsIp("10.99.1.10/32", "10.99.1.11")).toBe(false);
  });
});

describe("cidrsOverlap — laminar: nested or disjoint", () => {
  const cases: [string, string, boolean][] = [
    ["10.20.0.0/14", "10.16.0.0/12", true], // /14 nested in /12
    ["10.16.0.0/12", "10.20.0.0/14", true], // same, reversed
    ["10.20.0.0/14", "10.99.14.0/24", false], // disjoint
    ["10.20.0.0/14", "10.20.0.0/14", true], // identical
    ["10.99.0.0/16", "10.99.128.0/17", true], // nested at the half
    ["192.0.2.0/24", "198.51.100.0/24", false], // disjoint TEST-NETs
  ];

  test.each(cases)("overlaps(%s, %s) = %p", (a, b, want) => {
    expect(cidrsOverlap(a, b)).toBe(want);
    expect(cidrsOverlap(b, a)).toBe(want); // symmetric
  });

  test("non-canonical bases still compare by network address", () => {
    expect(cidrsOverlap("10.20.1.7/14", "10.20.0.0/14")).toBe(true);
  });
});

describe("hasHostBits / canonicalCidr", () => {
  test("flags a base with host bits set", () => {
    expect(hasHostBits("10.20.1.7/14")).toBe(true);
    expect(hasHostBits("10.20.0.0/14")).toBe(false);
    expect(canonicalCidr("10.20.1.7/14")).toBe("10.20.0.0/14");
  });

  test("/32 never has host bits; /0 only for 0.0.0.0", () => {
    expect(hasHostBits("10.99.1.10/32")).toBe(false);
    expect(hasHostBits("0.0.0.0/0")).toBe(false);
    expect(hasHostBits("10.0.0.0/0")).toBe(true);
  });
});
