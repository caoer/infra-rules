/**
 * `validate <registry.json>` — parse a registry file and report EVERY
 * violation. Exit codes (D18): 0 valid, 1 violations found (including
 * malformed JSON — a data problem, §5), 2 crash/usage.
 *
 * Runnable directly (`bun src/commands/validate.ts <file>`) and importable
 * by the Unit 3 CLI.
 */

import { readFileSync } from "node:fs";
import { RegistryWithIntegritySchema } from "../integrity.ts";
import type { Registry } from "../schema/registry.ts";

export interface ValidateIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: ValidateIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** ["snapshots","acme",3,"host"] → "snapshots.acme[3].host" */
export function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const part of path) {
    text += typeof part === "number" ? `[${part}]` : text === "" ? String(part) : `.${String(part)}`;
  }
  return text === "" ? "(registry root)" : text;
}

function countEntities(registry: Registry): number {
  let count = registry.hand.length;
  for (const entities of Object.values(registry.snapshots)) count += entities.length;
  return count;
}

export function runValidate(args: string[], io: ValidateIo = consoleIo): number {
  if (args.length !== 1 || args[0] === "--help") {
    io.err("usage: validate <registry.json>");
    return 2;
  }
  const file = args[0]!;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    io.err(`validate: cannot read ${file}: ${(error as Error).message}`);
    return 2;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    // Malformed JSON is a data problem, not a crash: fail fast, exit 1 (§5).
    io.out(`✗ ${file}: malformed JSON — ${(error as Error).message}`);
    return 1;
  }

  const result = RegistryWithIntegritySchema.safeParse(data);
  if (result.success) {
    const orgs = Object.keys(result.data.snapshots).length;
    io.out(`✓ ${file} — valid registry (${countEntities(result.data)} entities, ${orgs} org snapshots)`);
    return 0;
  }

  for (const issue of result.error.issues) {
    io.out(`✗ ${formatPath(issue.path)} — ${issue.message}`);
  }
  const n = result.error.issues.length;
  io.out(`${n} violation${n === 1 ? "" : "s"} in ${file}`);
  return 1;
}

if (import.meta.main) {
  process.exit(runValidate(process.argv.slice(2)));
}
