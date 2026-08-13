import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryWithIntegritySchema } from "../src/integrity.ts";
import { formatPath, runValidate, type ValidateIo } from "../src/commands/validate.ts";

const fixturesDir = join(import.meta.dir, "..", "fixtures");
const fixture = (name: string): string => join(fixturesDir, name);

/** Parse a fixture through schema + integrity; return every issue message. */
function violationsOf(name: string): { messages: string[]; paths: string[] } {
  const data = JSON.parse(readFileSync(fixture(name), "utf8"));
  const result = RegistryWithIntegritySchema.safeParse(data);
  if (result.success) return { messages: [], paths: [] };
  return {
    messages: result.error.issues.map((issue) => issue.message),
    paths: result.error.issues.map((issue) => formatPath(issue.path)),
  };
}

describe("integrity — valid registry", () => {
  test("valid.json produces zero violations", () => {
    const { messages } = violationsOf("valid.json");
    expect(messages).toEqual([]);
  });
});

describe("integrity — each check catches its violation class", () => {
  test("[host-ref] service.host must name a declared host entity", () => {
    const { messages, paths } = violationsOf("invalid-service-host-dangling.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[host-ref]");
    expect(messages[0]).toContain('service "grafana"');
    expect(messages[0]).toContain('"ghost"');
    expect(paths[0]).toBe("hand[0].host");
  });

  test("[policy-ref] routing.policy must name a declared policy entity", () => {
    const { messages, paths } = violationsOf("invalid-policy-dangling.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[policy-ref]");
    expect(messages[0]).toContain('routing "band-x"');
    expect(messages[0]).toContain('"ghost-policy"');
    expect(paths[0]).toBe("hand[0].policy");
  });

  test("[mesh-ref]/[network-ref] host membership references must resolve", () => {
    const { messages } = violationsOf("invalid-dangling-refs.json");
    expect(messages).toHaveLength(2);
    const meshIssue = messages.find((m) => m.startsWith("[mesh-ref]"));
    const networkIssue = messages.find((m) => m.startsWith("[network-ref]"));
    expect(meshIssue).toContain('mesh "ghost-mesh" is not a declared mesh entity');
    expect(networkIssue).toContain('network "ghost-lan" is not a declared network entity');
    expect(meshIssue).toContain('host "web-1"');
  });

  test("[dns-unique] a dnsName claimed by two services is a violation naming both", () => {
    const { messages, paths } = violationsOf("invalid-dns-duplicate.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[dns-unique]");
    expect(messages[0]).toContain('dnsName "grafana.acme.test"');
    expect(messages[0]).toContain('service "metrics"'); // the duplicate, identified stably
    expect(messages[0]).toContain('service "grafana"'); // the first holder, named
    expect(paths[0]).toBe("hand[2].dnsName");
  });

  test("[ip-in-cidr] easytier_ip outside its mesh and LAN ip outside its network", () => {
    const { messages, paths } = violationsOf("invalid-ip-outside-cidr.json");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toStartWith("[ip-in-cidr]");
    expect(messages[0]).toContain("easytier_ip 10.99.0.5");
    expect(messages[0]).toContain('mesh "mesh-a" cidr 10.20.0.0/14');
    expect(messages[1]).toStartWith("[ip-in-cidr]");
    expect(messages[1]).toContain("ip 198.51.100.9");
    expect(messages[1]).toContain('network "lan-alpha" cidr 192.0.2.0/24');
    expect(paths).toEqual(["snapshots.acme[2].easytier_ip", "snapshots.acme[2].networks.lan-alpha.ip"]);
  });

  test("[cidr-overlap] overlapping allocations are a violation naming both entities", () => {
    const { messages, paths } = violationsOf("invalid-cidr-overlap.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[cidr-overlap]");
    expect(messages[0]).toContain('mesh "mesh-o"');
    expect(messages[0]).toContain("10.99.128.0/17");
    expect(messages[0]).toContain('network "lan-a"');
    expect(messages[0]).toContain("10.99.0.0/16");
    expect(paths[0]).toBe("hand[1].cidr");
  });

  test("[cidr-canonical] a CIDR with host bits set is a violation, not silent masking", () => {
    const { messages, paths } = violationsOf("invalid-cidr-host-bits.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[cidr-canonical]");
    expect(messages[0]).toContain("10.99.1.0/22");
    expect(messages[0]).toContain("10.99.0.0/22"); // the canonical form, suggested
    expect(paths[0]).toBe("hand[0].cidr");
  });

  test("[retired-range] retired space hard-fails as cidr, as address, and as routing match", () => {
    const { messages } = violationsOf("invalid-retired-range.json");
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(message).toStartWith("[retired-range]");
    expect(messages.some((m) => m.includes("cidr 10.98.144.0/24") && m.includes('network "old-lan"'))).toBe(true);
    expect(
      messages.some((m) => m.includes("easytier_ip 10.98.200.5") && m.includes("10.98.192.0/20")),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("match.cidr 10.98.192.0/20") && m.includes('routing "dead-route"')),
    ).toBe(true);
  });

  test("[dup-entity] D4: same entity in snapshot and hand — both sources named, anchored on hand", () => {
    const { messages, paths } = violationsOf("invalid-duplicate-entity.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[dup-entity]");
    expect(messages[0]).toContain('host "web-1"');
    expect(messages[0]).toContain("snapshots.acme"); // source 1
    expect(messages[0]).toContain("hand"); // source 2 (via the identifier)
    expect(messages[0]).toContain("delete the hand entry"); // D4's fix
    expect(paths[0]).toBe("hand[0]");
  });

  test("[dup-entity] same kind+name twice in one section is ambiguous, so a violation", () => {
    const { messages, paths } = violationsOf("invalid-duplicate-in-section.json");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith("[dup-entity]");
    expect(messages[0]).toContain('policy "direct"');
    expect(paths[0]).toBe("hand[1]");
  });
});

describe("validate command — exit codes (D18)", () => {
  function run(args: string[]): { code: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const io: ValidateIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
    return { code: runValidate(args, io), out, err };
  }

  test("valid registry → 0, summary counts entities", () => {
    const { code, out } = run([fixture("valid.json")]);
    expect(code).toBe(0);
    expect(out[0]).toContain("valid registry");
    expect(out[0]).toContain("16 entities");
  });

  test("integrity violations → 1, one line per violation + summary", () => {
    const { code, out } = run([fixture("invalid-retired-range.json")]);
    expect(code).toBe(1);
    expect(out.filter((l) => l.startsWith("✗")).length).toBe(3);
    expect(out.at(-1)).toContain("3 violations");
  });

  test("schema-shape violation (wrong schemaVersion) → 1", () => {
    const { code, out } = run([fixture("invalid-schema-version.json")]);
    expect(code).toBe(1);
    expect(out.some((l) => l.includes("schemaVersion"))).toBe(true);
  });

  test("malformed JSON → 1 with the file named (§5: data problem, fail fast)", () => {
    const { code, out } = run([fixture("malformed.json")]);
    expect(code).toBe(1);
    expect(out[0]).toContain("malformed.json");
    expect(out[0]).toContain("malformed JSON");
  });

  test("usage error (no argument) → 2", () => {
    const { code, err } = run([]);
    expect(code).toBe(2);
    expect(err[0]).toContain("usage");
  });

  test("unreadable file → 2", () => {
    const { code } = run([fixture("does-not-exist.json")]);
    expect(code).toBe(2);
  });

  test("the file is directly runnable and exits with the real code", () => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "commands", "validate.ts"), fixture("valid.json")]);
    expect(proc.exitCode).toBe(0);
    const bad = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "commands", "validate.ts"), fixture("invalid-cidr-overlap.json")]);
    expect(bad.exitCode).toBe(1);
  });
});
