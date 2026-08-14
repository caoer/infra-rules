/**
 * Leak guard: no real fleet data may ever be committed under `fixtures/`.
 * This is the mechanical enforcement of public-repo discipline for every
 * unit — fixtures are synthetic by test, not by honor.
 *
 * Three rules, each strict by construction:
 *
 * 1. ADDRESS SPACE IS ALLOW-LISTED, NEVER DENY-LISTED. Fixture data may only
 *    use the synthetic bands and documentation ranges in `ALLOWED_RANGES`.
 *    Every other address fails, including all of RFC1918 outside the fixture
 *    bands. A deny-list would have to name the real fleet ranges to ban them,
 *    which writes exactly the data this repo must not carry — and it would
 *    still miss any range nobody thought to list.
 *
 * 2. PASSWORDS — every password value, in JSON (`"password": "…"`) or
 *    key=value form (`password=…`), must start with `fake-`. There is no
 *    other placeholder spelling; an allowlist of one prefix cannot be
 *    argued with.
 *
 * 3. The same allow-list blocks public unicast space, so real proxy-exit IPs
 *    cannot appear either — without writing a single real address into this
 *    public file, and without a deny-list a new exit could dodge.
 *
 * The scan is recursive and extension-agnostic so future units' fixture
 * trees (e.g. `fixtures/golden/*.dconf`) are covered automatically.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cidrContainsIp } from "../src/lib/cidr.ts";

/**
 * Scan roots: every directory that holds committed DATA files.
 *
 * `test/golden/` is in scope because a golden is fixture data that happens to
 * live under `test/` — U7 found it sitting outside the scan.
 *
 * `src/` and the rest of `test/` are covered by the separate no-real-data
 * prose sweep, because this repo is public: a real range named in a comment
 * is as published as one named in a fixture.
 */
const SCAN_ROOTS = [
  join(import.meta.dir, "..", "fixtures"),
  join(import.meta.dir, "golden"),
];

interface Leak {
  file: string;
  line: number;
  rule: string;
  match: string;
}

const PASSWORD_FORMS = [
  /"password"\s*:\s*"([^"]*)"/g, // JSON field
  /\bpassword\s*=\s*([^\s,"']+)/gi, // key=value (dconf/ini/url styles)
];

/**
 * The ONLY address space fixture data may use. Everything else fails — real
 * fleet ranges, real LAN ranges, and public unicast alike.
 *
 * The RFC1918 entries are deliberately narrow synthetic bands, not the whole
 * private space: `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` are where
 * real inventories actually live, so allowing them wholesale would let real
 * data in through the front door.
 */
const ALLOWED_RANGES = [
  "10.98.0.0/15", // synthetic fixture band (10.98–10.99)
  "10.20.0.0/14", // synthetic CIDR-math band
  "10.30.0.0/16", // synthetic CIDR-math band
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local
  "192.0.2.0/24", // TEST-NET-1
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "198.18.0.0/15", // benchmarking
  "0.0.0.0/8", // "this network"
  "240.0.0.0/4", // reserved Class E (incl. 255.255.255.255)
];

const IPV4_SHAPED = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function isRealIpv4(token: string): boolean {
  return token.split(".").every((octet) => Number(octet) <= 255);
}

function listFixtureFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Every data file across every scan root, labelled by the root it came from. */
function scannedFiles(): Array<{ label: string; path: string }> {
  return SCAN_ROOTS.flatMap((root) =>
    listFixtureFiles(root).map((file) => ({
      label: `${relative(join(import.meta.dir, ".."), root)}/${file}`,
      path: join(root, file),
    })),
  );
}

function scanLine(file: string, line: string, lineNo: number, leaks: Leak[]): void {
  for (const form of PASSWORD_FORMS) {
    form.lastIndex = 0;
    for (const match of line.matchAll(form)) {
      const value = match[1] ?? "";
      if (!value.startsWith("fake-")) {
        leaks.push({
          file,
          line: lineNo,
          rule: "password-not-placeholder (values must start with `fake-`)",
          match: match[0],
        });
      }
    }
  }

  for (const match of line.matchAll(IPV4_SHAPED)) {
    const token = match[0];
    if (!isRealIpv4(token)) continue; // e.g. 999.1.1.1 — not an address
    if (!ALLOWED_RANGES.some((range) => cidrContainsIp(range, token))) {
      leaks.push({
        file,
        line: lineNo,
        rule: "address-outside-fixture-space",
        match: token,
      });
    }
  }
}

function scanFixtures(): Leak[] {
  const leaks: Leak[] = [];
  for (const { label, path } of scannedFiles()) {
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, i) => scanLine(label, line, i + 1, leaks));
  }
  return leaks;
}

describe("leak guard — committed data carries no real fleet data", () => {
  test("every address sits in fixture space, every password is a placeholder", () => {
    const leaks = scanFixtures().map(
      (leak) => `${leak.file}:${leak.line} [${leak.rule}] ${leak.match}`,
    );
    expect(leaks).toEqual([]);
  });

  test("the scan sees every root (guards against a silently-empty scan)", () => {
    expect(scannedFiles().length).toBeGreaterThanOrEqual(13);
    for (const root of SCAN_ROOTS) {
      expect(listFixtureFiles(root).length).toBeGreaterThan(0);
    }
  });

  // The rules themselves are tested here against inline samples, so a
  // regression in a pattern fails THIS file even while fixtures/ is clean.
  test("rule self-check: each rule catches its class and passes its placeholder", () => {
    const catches = (line: string): string[] => {
      const leaks: Leak[] = [];
      scanLine("inline", line, 1, leaks);
      return leaks.map((leak) => leak.rule);
    };

    // Any 10-space outside the synthetic bands fails, so a real fleet range
    // is caught without this file ever naming one.
    expect(catches('"cidr": "10.1.0.0/14"')).toContainEqual("address-outside-fixture-space");
    expect(catches("addr 10.77.1.2 up")).toContainEqual("address-outside-fixture-space");
    // Whole-RFC1918 space is not a free pass either.
    expect(catches('"ip": "192.168.1.10"')).toContainEqual("address-outside-fixture-space");
    expect(catches('"ip": "172.16.4.2"')).toContainEqual("address-outside-fixture-space");

    expect(catches('"password": "hunter2"').join()).toContain("password-not-placeholder");
    expect(catches("password=s3cret,method=aes").join()).toContain("password-not-placeholder");
    expect(catches('"password": "fake-fixture-password"')).toEqual([]);
    expect(catches("password=fake-golden-pw")).toEqual([]);

    // Public unicast (the space real exit IPs live in) still fails.
    expect(catches('"host": "142.250.80.14"')).toContainEqual("address-outside-fixture-space");
    expect(catches('"host": "203.0.113.7"')).toEqual([]); // TEST-NET-3 stays legal
    expect(catches('"ip": "10.99.1.10"')).toEqual([]); // synthetic band stays legal
    expect(catches("v 999.1.1.1 is no address")).toEqual([]);
    expect(catches("version 1.3.14 ok")).toEqual([]);
  });
});
