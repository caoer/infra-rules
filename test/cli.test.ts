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
    // Render first: an unrendered out dir is a MISSING tree, not a matching
    // one, and every registered renderer's file has to be on disk for the
    // comparison to mean anything.
    expect(await cli("render", "--registry", registryPath, "--out", outDir)).toBe(0);
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

/**
 * `--produced` exists for the consuming repos' regen recipes. Rendered
 * artifacts are COMMITTED there, so an entity removed from the registry
 * leaves its already-committed file tracked, unmodified and stale — nothing
 * in `git status` says so. The recipe diffs this listing against the output
 * directory to spot the orphan, instead of maintaining its own expected-
 * outputs list that would drift from the renderers.
 */
describe("render --produced (stale-artifact detection for consumers)", () => {
  test("stdout carries only the produced paths, so a recipe can read it directly", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "render", "--registry", registryPath, "--out", outDir, "--produced", "-"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    // Every line is a real relative path — no summary line mixed into stdout.
    const lines = stdout.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("rendered ");
      expect(await Bun.file(join(outDir, line)).exists()).toBe(true);
    }
    // The human summary is still emitted, on stderr.
    expect(await new Response(proc.stderr).text()).toContain("rendered ");
  });

  test("the listing names exactly the files on disk, so an orphan is detectable", async () => {
    await runRender({ registryPath, outDir, renderers: [hostsRenderer], producedListPath: join(dir, "produced.txt") });
    const produced = (await Bun.file(join(dir, "produced.txt")).text()).trim().split("\n");
    expect(produced).toEqual(["hosts.json"]);

    // A file a previous render committed, no longer produced: on disk, absent
    // from the listing. That difference is the whole detection mechanism.
    await writeFile(join(outDir, "stale.json"), "{}");
    const onDisk = [...new Bun.Glob("*.json").scanSync(outDir)].sort();
    expect(onDisk).toEqual(["hosts.json", "stale.json"]);
    expect(onDisk.filter((f) => !produced.includes(f))).toEqual(["stale.json"]);
  });
});

/**
 * CLI WIRING. These exist because U3's suite passed while `validate` was
 * never reachable from the CLI at all: the command module was tested
 * directly, so nothing noticed that cli.ts had no route to it. The publish
 * gates in the consuming repos invoke the BINARY, so the binary is what has
 * to be tested.
 */
describe("cli wiring", () => {
  async function run(...args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  }

  const valid = join(import.meta.dir, "..", "fixtures", "valid.json");

  test("validate is reachable from the CLI, positionally, and exits 0 on a valid registry", async () => {
    const { code, stdout } = await run("validate", valid);
    expect(code).toBe(0);
    expect(stdout).toContain("valid registry");
  });

  test("validate also accepts --registry, for symmetry with render/diff", async () => {
    expect((await run("validate", "--registry", valid)).code).toBe(0);
  });

  test("validate exits 1 on a bad registry, so a publish gate can block on it", async () => {
    const bad = join(import.meta.dir, "..", "fixtures", "malformed.json");
    expect((await run("validate", bad)).code).toBe(1);
  });

  test("every command in the usage text is actually routed", async () => {
    const usage = (await run("--help")).stdout;
    for (const command of ["validate", "render", "diff"]) {
      expect(usage).toContain(command);
      // An unrouted command exits 2 with "unknown command"; a routed one
      // reaches its handler and fails on missing arguments instead.
      const { stdout: _s, code } = await run(command);
      expect(code).toBe(2);
      const proc = Bun.spawn(["bun", CLI, command], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      expect(await new Response(proc.stderr).text()).not.toContain("unknown command");
    }
  });

  test("package.json exposes the CLI as a bin, or `bun add` gives consumers nothing", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(pkg.bin?.["infra-rules"]).toBeDefined();
    expect(pkg.private).toBeUndefined(); // private blocks consumption
  });

  test("--views scopes what reaches disk; an unknown view exits 2 without writing", async () => {
    const scopedOut = join(dir, "scoped");
    const { code } = await run("render", "--registry", valid, "--out", scopedOut, "--views", "vpn");
    expect(code).toBe(0);
    expect(await Bun.file(join(scopedOut, "records/vpn.json")).exists()).toBe(true);
    expect(await Bun.file(join(scopedOut, "records/office.json")).exists()).toBe(false);

    const typoOut = join(dir, "typo");
    expect((await run("render", "--registry", valid, "--out", typoOut, "--views", "vpm")).code).toBe(2);
    expect(await Bun.file(join(typoOut, "records/vpn.json")).exists()).toBe(false);
  });
});
