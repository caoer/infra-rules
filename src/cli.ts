#!/usr/bin/env bun
/**
 * infra-rules CLI.
 *
 * ADDING A COMMAND — one entry in COMMANDS below plus its module under
 * `src/commands/`. Each handler returns its process exit code; anything it
 * throws becomes exit 2 with the message on stderr.
 *
 * Exit codes (D18):
 *   render  0 rendered            2 failed
 *   diff    0 no difference       1 difference found       2 failed
 *   publish 0 applied / dry run   2 failed
 */

import { runDiff } from "./commands/diff.ts";
import { runPublishCloudflare } from "./commands/publish-cloudflare.ts";
import { runRender } from "./commands/render.ts";
import { runRenderSurge } from "./commands/render-surge.ts";
import { runValidate } from "./commands/validate.ts";

const USAGE = `usage: infra-rules <command> [options]

commands:
  validate <registry.json>               report every violation
                                         (exit 0 valid, 1 violations, 2 usage)
  render --registry <file> --out <dir> [--produced <file>|-] [--views a,b]
                                         write artifacts (exit 0 ok, 2 failed);
                                         --produced lists what was written, one
                                         relative path per line, "-" for stdout;
                                         --views limits output to those views —
                                         REQUIRED when --out is a per-org repo
  diff   --registry <file> --out <dir> [--views a,b]
                                         compare artifacts (0 same, 1 differ, 2 failed)
  render-surge --registry <file> --layout <file> --out <file>
                                         write the Surge dconf to one explicit file
                                         (exit 0 ok, 2 failed); never part of \`render\` —
                                         the artifact carries proxy credentials
  publish cloudflare --zone <zone> --records <file> [--records <file>...] [--dry-run]
                                         upsert rendered records/<view>.json files into a
                                         Cloudflare zone (exit 0 ok, 2 failed); token from
                                         $CF_API_TOKEN; writes DNS-only records tagged
                                         infra-rules:<view> and deletes only those
`;

/** Flag name → every value given, in order. Boolean flags hold `[""]`. */
type Flags = Map<string, string[]>;
type Handler = (flags: Flags) => Promise<number>;

/** Flags that take no value. Everything else takes exactly one. */
const BOOLEAN_FLAGS = new Set(["dry-run"]);

function required(flags: Flags, name: string): string {
  const values = flags.get(name);
  if (values === undefined) throw new Error(`missing required flag --${name}`);
  if (values.length > 1) throw new Error(`flag --${name} given ${values.length} times; it takes one value`);
  return values[0]!;
}

function optional(flags: Flags, name: string): string | undefined {
  return flags.has(name) ? required(flags, name) : undefined;
}

function requiredList(flags: Flags, name: string): string[] {
  const values = flags.get(name);
  if (values === undefined) throw new Error(`missing required flag --${name} (repeatable)`);
  return values;
}

/**
 * `validate` takes a positional file (`validate registry.json`) because that
 * is how the consuming publish gates invoke it, and also accepts
 * `--registry <file>` for symmetry with the other commands.
 */
function validateArgs(rest: string[]): string[] {
  if (rest.length > 0 && !rest[0]!.startsWith("--")) return rest;
  const flags = parseFlags(rest);
  return [required(flags, "registry")];
}

const COMMANDS: Record<string, Handler> = {
  render: (flags) =>
    runRender({
      registryPath: required(flags, "registry"),
      outDir: required(flags, "out"),
      producedListPath: optional(flags, "produced"),
      views: viewList(flags),
    }),
  diff: (flags) =>
    runDiff({
      registryPath: required(flags, "registry"),
      outDir: required(flags, "out"),
      views: viewList(flags),
    }),
  "render-surge": (flags) =>
    runRenderSurge({
      registryPath: required(flags, "registry"),
      layoutPath: required(flags, "layout"),
      outPath: required(flags, "out"),
    }),
  "publish cloudflare": (flags) =>
    runPublishCloudflare({
      zone: required(flags, "zone"),
      recordsPaths: requiredList(flags, "records"),
      dryRun: flags.has("dry-run"),
    }),
};

/** `--views a,b` → ["a","b"]; absent → undefined (render every view). */
function viewList(flags: Flags): string[] | undefined {
  const raw = optional(flags, "views");
  if (raw === undefined) return undefined;
  const views = raw.split(",").map((v) => v.trim()).filter((v) => v !== "");
  if (views.length === 0) throw new Error("--views needs at least one view name");
  return views;
}

/** `--key value` and `--key=value`, repeatable; unknown flags are an error, not a silent no-op. */
function parseFlags(argv: string[]): Flags {
  const flags: Flags = new Map();
  const add = (key: string, value: string) => flags.set(key, [...(flags.get(key) ?? []), value]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      add(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      add(key, "");
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`flag ${arg} needs a value`);
    add(key, value);
  }
  return flags;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "validate") {
    try {
      return runValidate(validateArgs(rest));
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }
  // Two-word commands (`publish cloudflare`) consume their first positional.
  const name = command === "publish" && rest[0] !== undefined ? `${command} ${rest.shift()}` : command;
  const handler = COMMANDS[name];
  if (handler === undefined) {
    console.error(`unknown command: ${name}\n\n${USAGE}`);
    return 2;
  }
  try {
    return await handler(parseFlags(rest));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
