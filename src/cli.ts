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

const USAGE = `usage: infra-rules <command> [options]

commands:
  render --registry <file> --out <dir> [--produced <file>|-]
                                         write artifacts (exit 0 ok, 2 failed);
                                         --produced lists what was written, one
                                         relative path per line, "-" for stdout
  diff   --registry <file> --out <dir>   compare artifacts (exit 0 same, 1 differ, 2 failed)
`;

type Handler = (flags: Map<string, string>) => Promise<number>;

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag --${name}`);
  return value;
}

const COMMANDS: Record<string, Handler> = {
  render: (flags) =>
    runRender({
      registryPath: required(flags, "registry"),
      outDir: required(flags, "out"),
      producedListPath: flags.get("produced"),
    }),
  diff: (flags) =>
    runDiff({ registryPath: required(flags, "registry"), outDir: required(flags, "out") }),
};

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
