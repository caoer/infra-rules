import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runRender } from "../src/commands/render.ts";
import { runDiff } from "../src/commands/diff.ts";
import type { Renderer } from "../src/render/index.ts";
import type { Registry } from "../src/schema/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const registry: Registry = {
  schemaVersion: 1,
  snapshots: {},
  hand: [{ kind: "host", name: "alpha", easytier_ip: "10.99.14.1" }],
};

const hostsRenderer: Renderer = {
  name: "hosts",
  render: (reg) => [{ path: "hosts.json", value: { count: reg.hand.length } }],
};

let dir: string;
let registryPath: string;
let outDir: string;

beforeEach(async () => {
  await mkdir(join(import.meta.dir, ".tmp"), { recursive: true });
  dir = await mkdtemp(join(import.meta.dir, ".tmp", "cli-"));
  registryPath = join(dir, "registry.json");
  outDir = join(dir, "out");
  await writeFile(registryPath, JSON.stringify(registry));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<number> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return await proc.exited;
}

describe("cli exit codes (D18)", () => {
  test("render succeeds with 0", async () => {
    expect(await cli("render", "--registry", registryPath, "--out", outDir)).toBe(0);
  });

  test("diff on a matching tree exits 0", async () => {
    expect(await cli("diff", "--registry", registryPath, "--out", outDir)).toBe(0);
  });

  test("an unparseable registry exits 2", async () => {
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 99, snapshots: {}, hand: [] }));
    expect(await cli("render", "--registry", registryPath, "--out", outDir)).toBe(2);
  });

  test("a missing registry file exits 2", async () => {
    expect(await cli("render", "--registry", join(dir, "absent.json"), "--out", outDir)).toBe(2);
  });

  test("a missing required flag exits 2", async () => {
    expect(await cli("render", "--registry", registryPath)).toBe(2);
  });

  test("an unknown command exits 2", async () => {
    expect(await cli("frobnicate")).toBe(2);
  });

  test("no arguments exits 2 with usage", async () => {
    expect(await cli()).toBe(2);
  });

  test("--help exits 0", async () => {
    expect(await cli("--help")).toBe(0);
  });
});

describe("render and diff round trip", () => {
  test("diff finds a difference (1), render fixes it (0), diff agrees (0)", async () => {
    const options = { registryPath, outDir, renderers: [hostsRenderer] };
    expect(await runDiff(options)).toBe(1);
    expect(await runRender(options)).toBe(0);
    expect(await runDiff(options)).toBe(0);

    await writeFile(join(outDir, "hosts.json"), "{}\n");
    expect(await runDiff(options)).toBe(1);
  });
});
