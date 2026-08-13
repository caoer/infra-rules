import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildFileSet } from "../src/commands/render.ts";
import { registerRenderer, renderers, resetRenderers, type Renderer } from "../src/render/index.ts";
import { DO_NOT_EDIT, HEADER_KEY, canonicalJson } from "../src/lib/canonical.ts";
import type { Registry } from "../src/schema/registry.ts";

const GOLDEN = join(import.meta.dir, "golden", "hosts.json");

/** Synthetic fleet — no real CIDRs, no real host names. */
const registry: Registry = {
  schemaVersion: 1,
  snapshots: {
    acme: [
      {
        kind: "host",
        name: "beta",
        roles: ["worker"],
        easytier_ip: "10.99.14.2",
        networks: { lab: { ip: "192.0.2.20" } },
      },
      {
        kind: "host",
        name: "alpha",
        roles: ["jumper"],
        region: "eu",
        easytier_ip: "10.99.14.1",
      },
    ],
  },
  hand: [{ kind: "host", name: "gamma", easytier_ip: "10.99.14.3" }],
};

/** A renderer standing in for the real ones (Units 4, 6, 7, 13). */
const hostsRenderer: Renderer = {
  name: "hosts",
  render(reg) {
    const all = [...Object.values(reg.snapshots).flat(), ...reg.hand];
    const hosts = all.filter((entity) => entity.kind === "host");
    return [
      {
        path: "hosts.json",
        value: {
          hosts: hosts
            .map((host) => ({ name: host.name, meshIp: host.easytier_ip ?? null }))
            .sort((a, b) => (a.name < b.name ? -1 : 1)),
        },
      },
    ];
  },
};

describe("canonical rendering", () => {
  test("two renders of the same registry are byte-identical", () => {
    const first = buildFileSet(registry, "/out", [hostsRenderer]);
    const second = buildFileSet(registry, "/out", [hostsRenderer]);
    expect([...second]).toEqual([...first]);
  });

  test("matches the committed golden", async () => {
    const files = buildFileSet(registry, "/out", [hostsRenderer]);
    const golden = await readFile(GOLDEN, "utf8");
    expect(files.get("/out/hosts.json")).toBe(golden);
  });

  test("key insertion order does not change the bytes", () => {
    const reordered = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(reordered);
    expect(reordered).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });

  test("every rendered file carries the DO NOT EDIT header", () => {
    const files = buildFileSet(registry, "/out", [hostsRenderer]);
    for (const contents of files.values()) {
      expect(JSON.parse(contents)[HEADER_KEY]).toBe(DO_NOT_EDIT);
    }
  });

  test("output is strict JSON — no comments, no trailing commas", () => {
    const contents = buildFileSet(registry, "/out", [hostsRenderer]).get("/out/hosts.json");
    expect(contents).not.toMatch(/\/\/|\/\*/);
    expect(contents).not.toMatch(/,\s*[}\]]/);
    expect(() => JSON.parse(contents as string)).not.toThrow();
  });

  test("non-finite numbers fail the render instead of becoming null", () => {
    expect(() => canonicalJson({ ttl: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  test("two renderers claiming one path is an error", () => {
    const twin: Renderer = { ...hostsRenderer, name: "twin" };
    expect(() => buildFileSet(registry, "/out", [hostsRenderer, twin])).toThrow(/both render/);
  });

  test("a path escaping the output root is an error", () => {
    const escapee: Renderer = {
      name: "escapee",
      render: () => [{ path: "../outside.json", value: {} }],
    };
    expect(() => buildFileSet(registry, "/out", [escapee])).toThrow(/output root/);
  });
});

describe("renderer registry", () => {
  test("registration is one line per renderer and order is name-sorted", () => {
    resetRenderers();
    registerRenderer({ name: "zulu", render: () => [] });
    registerRenderer({ name: "alpha", render: () => [] });
    expect(renderers().map((r) => r.name)).toEqual(["alpha", "zulu"]);
    expect(() => registerRenderer({ name: "zulu", render: () => [] })).toThrow(/twice/);
    resetRenderers();
  });
});
