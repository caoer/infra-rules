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
 */

import { runDiff } from "./commands/diff.ts";
import { runRender } from "./commands/render.ts";
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
`;

type Handler = (flags: Map<string, string>) => Promise<number>;

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag --${name}`);
  return value;
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
      producedListPath: flags.get("produced"),
      views: viewList(flags),
    }),
  diff: (flags) =>
    runDiff({
      registryPath: required(flags, "registry"),
      outDir: required(flags, "out"),
      views: viewList(flags),
    }),
};

/** `--views a,b` → ["a","b"]; absent → undefined (render every view). */
function viewList(flags: Map<string, string>): string[] | undefined {
  const raw = flags.get("views");
  if (raw === undefined) return undefined;
  const views = raw.split(",").map((v) => v.trim()).filter((v) => v !== "");
  if (views.length === 0) throw new Error("--views needs at least one view name");
  return views;
}

/** `--key value` and `--key=value`; unknown flags are an error, not a silent no-op. */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`flag ${arg} needs a value`);
    flags.set(arg.slice(2), value);
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
  const handler = COMMANDS[command];
  if (handler === undefined) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
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
