import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runRender } from "../src/commands/render.ts";
import { runDiff } from "../src/commands/diff.ts";
import type { Renderer } from "../src/render/index.ts";
import { RegistrySchema, type Registry } from "../src/schema/registry.ts";
import { RegistryWithIntegritySchema } from "../src/integrity.ts";

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
 * INTEGRITY AT THE WRITE BOUNDARY. `validate` was the only command parsing
 * with the integrity refinements, so every command that WRITES artifacts —
 * including the one that writes credentials — skipped retired-range,
 * duplicate-entity and dangling-ref checks. The guard has to fire on the
 * writers, and it has to decline before anything reaches disk.
 */
describe("render commands refuse an integrity-violating registry", () => {
  const invalid = join(import.meta.dir, "..", "fixtures", "invalid-retired-range.json");
  const layout = join(import.meta.dir, "..", "fixtures", "surge-layout.json");

  test("render declines and writes nothing", async () => {
    expect(await cli("render", "--registry", invalid, "--out", outDir)).toBe(2);
    expect(await Bun.file(outDir).exists()).toBe(false);
  });

  test("diff declines", async () => {
    expect(await cli("diff", "--registry", invalid, "--out", outDir)).toBe(2);
  });

  test("render-surge declines and writes no credential file", async () => {
    const out = join(dir, "surge.dconf");
    expect(await cli("render-surge", "--registry", invalid, "--layout", layout, "--out", out)).toBe(2);
    expect(await Bun.file(out).exists()).toBe(false);
  });

  test("the same registry still parses under the bare shape schema — the refinement is what refuses", async () => {
    const data = JSON.parse(await Bun.file(invalid).text());
    expect(RegistrySchema.safeParse(data).success).toBe(true);
    expect(RegistryWithIntegritySchema.safeParse(data).success).toBe(false);
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
    for (const command of ["validate", "render", "diff", "render-surge", "publish cloudflare"]) {
      expect(usage).toContain(command);
      // An unrouted command exits 2 with "unknown command"; a routed one
      // reaches its handler and fails on missing arguments instead.
      const words = command.split(" ");
      const { stdout: _s, code } = await run(...words);
      expect(code).toBe(2);
      const proc = Bun.spawn(["bun", CLI, ...words], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      expect(await new Response(proc.stderr).text()).not.toContain("unknown command");
    }
  });

  test("publish cloudflare is routed as a two-word command and reads its token from the environment, never a flag", async () => {
    const stderrOf = async (env: Record<string, string | undefined>, ...args: string[]) => {
      const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
      return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
    };
    const unset = await stderrOf({ CF_API_TOKEN: undefined }, "publish", "cloudflare", "--zone", "acme.test", "--records", "a.json", "--records", "b.json", "--dry-run");
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("CF_API_TOKEN is not set");
    expect(unset.stderr).not.toContain("unknown command");

    // With a token the command proceeds to its inputs: the repeated --records
    // flag is accepted and the first missing file is what fails.
    const missing = await stderrOf({ CF_API_TOKEN: "fake-token" }, "publish", "cloudflare", "--zone", "acme.test", "--records", join(dir, "a.json"), "--records", join(dir, "b.json"));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("ENOENT");

    expect((await stderrOf({}, "publish", "elsewhere")).stderr).toContain("unknown command: publish elsewhere");
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
