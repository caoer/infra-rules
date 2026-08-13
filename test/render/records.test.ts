/**
 * Unit 7 — the per-view DNS records renderer.
 *
 * Input is `fixtures/valid.json`, reused rather than re-invented: it already
 * carries the exact case this renderer exists for. Host `jump-1` lives on
 * mesh `mesh-a` and on NO network, so its service `jump.acme.test` has an
 * answer in the mesh view `vpn` and none in the network view `office`. A
 * renderer that fell back to "the address I have" would emit a mesh IP into
 * the office file; the correct output omits the name there entirely.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildFileSet } from "../../src/commands/render.ts";
import { RegistrySchema, type Registry } from "../../src/schema/registry.ts";
import { renderers, resetRenderers } from "../../src/render/index.ts";
import { renderRecords } from "../../src/render/records.ts";
import { canonicalJson, stampHeader } from "../../src/lib/canonical.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");
const OUT = "/out";

async function loadFixture(name: string): Promise<Registry> {
  return RegistrySchema.parse(JSON.parse(await readFile(join(FIXTURES, name), "utf8")));
}

const registry = await loadFixture("valid.json");

function render(reg: Registry = registry): Map<string, string> {
  return buildFileSet(reg, OUT, [{ name: "records", render: renderRecords }]);
}

function fileFor(view: string, files = render()): string {
  const contents = files.get(`${OUT}/records/${view}.json`);
  if (contents === undefined) throw new Error(`no rendered file for view "${view}"`);
  return contents;
}

describe("records renderer — registration and shape", () => {
  // The global registry is process-wide and other test files reset it, so
  // registration is asserted from a clean slate rather than from whatever
  // state the file order happens to leave behind.
  test("the module registers itself under the name `records`", async () => {
    resetRenderers();
    try {
      await import(`../../src/render/records.ts?reregister=${Date.now()}`);
      expect(renderers().map((r) => r.name)).toContain("records");
    } finally {
      resetRenderers();
    }
  });

  test("the registry file carries the one-line registration", async () => {
    const index = await readFile(
      join(import.meta.dir, "..", "..", "src", "render", "index.ts"),
      "utf8",
    );
    expect(index).toContain('import "./records.ts";');
  });

  test("one file per view, named for the view", () => {
    expect([...render().keys()].sort()).toEqual([
      `${OUT}/records/office.json`,
      `${OUT}/records/vpn.json`,
    ]);
  });

  test("each file states its own vantage", () => {
    expect(JSON.parse(fileFor("vpn")).scope).toEqual({ kind: "mesh", mesh: "mesh-a" });
    expect(JSON.parse(fileFor("office")).scope).toEqual({
      kind: "network",
      network: "lan-alpha",
    });
  });

  test("records are sorted by DNS name", () => {
    const names = JSON.parse(fileFor("vpn")).records.map((r: { name: string }) => r.name);
    expect(names).toEqual([...names].sort());
    expect(names.length).toBeGreaterThan(1);
  });
});

describe("records renderer — a mesh address never reaches a non-mesh view", () => {
  test("the mesh-only host is answered in the mesh view and omitted from the network view", () => {
    const vpn = JSON.parse(fileFor("vpn")).records;
    const office = JSON.parse(fileFor("office")).records;

    expect(vpn).toContainEqual({
      name: "jump.acme.test",
      type: "A",
      value: "10.20.1.8",
      host: "jump-1",
    });
    // Same name, no answer from the office vantage — omitted, not defaulted.
    expect(office.map((r: { name: string }) => r.name)).not.toContain("jump.acme.test");
  });

  test("no mesh address appears anywhere in a non-mesh view's file", () => {
    const meshIps = [...Object.values(registry.snapshots).flat(), ...registry.hand]
      .filter((entity) => entity.kind === "host" && entity.mesh !== undefined)
      .map((entity) => (entity as { easytier_ip?: string }).easytier_ip)
      .filter((ip): ip is string => ip !== undefined);
    expect(meshIps.length).toBeGreaterThan(0);

    const office = fileFor("office");
    for (const ip of meshIps) expect(office).not.toContain(ip);
  });

  test("a host on both the mesh and the network is answered differently per view", () => {
    const answer = (view: string) =>
      JSON.parse(fileFor(view)).records.find(
        (r: { name: string }) => r.name === "grafana.acme.test",
      ).value;
    expect(answer("vpn")).toBe("10.20.1.7"); // mesh address
    expect(answer("office")).toBe("192.0.2.10"); // lan-alpha address
  });

  test("a view whose scope no host matches renders an empty record list, not a default", () => {
    const orphan: Registry = {
      ...registry,
      hand: [
        ...registry.hand,
        { kind: "network", name: "lan-empty", cidr: "198.51.100.0/24" },
        { kind: "view", name: "nowhere", scope: { kind: "network", network: "lan-empty" } },
      ],
    };
    expect(JSON.parse(fileFor("nowhere", render(orphan))).records).toEqual([]);
  });
});

describe("records renderer — determinism", () => {
  test("two renders of the same registry are byte-identical", () => {
    expect([...render()]).toEqual([...render()]);
  });

  test("matches the committed goldens", async () => {
    for (const view of ["office", "vpn"]) {
      const golden = await readFile(join(FIXTURES, "golden", `records-${view}.json`), "utf8");
      expect(fileFor(view)).toBe(golden);
    }
  });

  test("entity order in the registry does not change the bytes", () => {
    const reversed: Registry = {
      ...registry,
      hand: [...registry.hand].reverse(),
      snapshots: Object.fromEntries(
        Object.entries(registry.snapshots).map(([org, list]) => [org, [...list].reverse()]),
      ),
    };
    expect([...render(reversed)]).toEqual([...render()]);
  });
});

describe("records renderer — failure is loud", () => {
  test("a service pointing at an undeclared host throws instead of omitting the name", () => {
    const dangling: Registry = {
      ...registry,
      hand: [
        ...registry.hand,
        { kind: "service", name: "ghost", dnsName: "ghost.acme.test", host: "no-such-host" },
      ],
    };
    expect(() => render(dangling)).toThrow(/undeclared host "no-such-host"/);
  });
});

describe("records renderer — the file reads as a zone", () => {
  test("the golden carries the DO NOT EDIT header and parses as strict JSON", async () => {
    const golden = await readFile(join(FIXTURES, "golden", "records-vpn.json"), "utf8");
    expect(golden).toBe(canonicalJson(stampHeader(JSON.parse(golden))));
    expect(golden).not.toMatch(/\/\/|\/\*/);
  });
});
