/**
 * Leak guard: no real fleet data may ever be committed under `fixtures/`.
 * This is the mechanical enforcement of public-repo discipline for every
 * unit — fixtures are synthetic by test, not by honor.
 *
 * Three rules, each strict by construction:
 *
 * 1. LIVE FLEET CIDRS — any `10.97.*`, `10.96.*`, `10.95.*` occurrence
 *    fails, in any syntax (address, CIDR, prose).
 *
 * 2. PASSWORDS — every password value, in JSON (`"password": "…"`) or
 *    key=value form (`password=…`), must start with `fake-`. There is no
 *    other placeholder spelling; an allowlist of one prefix cannot be
 *    argued with.
 *
 * 3. PUBLIC IPS — every IPv4-shaped token must sit in private, loopback,
 *    link-local, CGNAT, documentation (TEST-NET-1/2/3), benchmarking,
 *    "this network", or reserved-Class-E space. Known exit IPs are public
 *    unicast addresses by definition, so banning ALL public unicast space
 *    blocks every one of them — without writing the real IPs into this
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
 * live under `test/` — U7 found it sitting outside the scan. The rest of
 * `test/` and all of `src/` stay out on purpose: they carry prose about the
 * fleet (a comment explaining why `10.96.0.0/14` sits inside `10.88.0.0/12`
 * is documentation, not a leak), so scanning them would train people to
 * weaken the rules. Data directories only, and no exceptions inside them.
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

const LIVE_FLEET_PREFIX = /\b10\.(?:56|60|61)\./;

const PASSWORD_FORMS = [
  /"password"\s*:\s*"([^"]*)"/g, // JSON field
  /\bpassword\s*=\s*([^\s,"']+)/gi, // key=value (dconf/ini/url styles)
];

/** Address space fixture data may use. Everything else is public unicast —
 * the space real exit IPs live in — and fails the scan. */
const ALLOWED_RANGES = [
  "10.0.0.0/8", // RFC1918 (rule 1 carves out the live fleet bands)
  "172.16.0.0/12", // RFC1918
  "192.168.0.0/16", // RFC1918
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // CGNAT
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
  if (LIVE_FLEET_PREFIX.test(line)) {
    leaks.push({
      file,
      line: lineNo,
      rule: "live-fleet-cidr",
      match: line.match(LIVE_FLEET_PREFIX)![0],
    });
  }

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
      leaks.push({ file, line: lineNo, rule: "public-ip (possible exit IP)", match: token });
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
  test("no live fleet CIDR, no real password, no public IP in any scanned data file", () => {
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

    expect(catches('"cidr": "10.96.0.0/14"')).toContainEqual("live-fleet-cidr");
    expect(catches("addr 10.97.1.2 up")).toContainEqual("live-fleet-cidr");
    expect(catches("edge 10.95.3.0/24")).toContainEqual("live-fleet-cidr");
    expect(catches('"ip": "110.97.1.2"')).not.toContainEqual("live-fleet-cidr"); // word boundary

    expect(catches('"password": "hunter2"').join()).toContain("password-not-placeholder");
    expect(catches("password=s3cret,method=aes").join()).toContain("password-not-placeholder");
    expect(catches('"password": "fake-fixture-password"')).toEqual([]);
    expect(catches("password=fake-golden-pw")).toEqual([]);

    expect(catches('"host": "142.250.80.14"').join()).toContain("public-ip");
    expect(catches('"host": "203.0.113.7"')).toEqual([]); // TEST-NET-3 stays legal
    expect(catches("v 999.1.1.1 is no address")).toEqual([]);
    expect(catches("version 1.3.14 ok")).toEqual([]);
  });
});
