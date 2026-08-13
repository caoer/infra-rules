/**
 * `diff` — what would `render` change?
 *
 * Same file set as `render`, compared against the tree instead of written to
 * it. Used in CI to prove committed artifacts match the registry.
 */

import { readFile } from "node:fs/promises";

import { buildFileSet, loadRegistry } from "./render.ts";
import type { Renderer } from "../render/index.ts";
import { scopeToViews } from "../lib/scope.ts";

export interface DiffOptions {
  registryPath: string;
  outDir: string;
  renderers?: Renderer[];
  /** Same allowlist as `render` — an unscoped diff against a scoped tree
   * would report every other org's artifacts as missing. */
  views?: readonly string[];
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Exit code per D18: 0 no difference, 1 difference found, 2 crash (thrown). */
export async function runDiff(options: DiffOptions): Promise<number> {
  const loaded = await loadRegistry(options.registryPath);
  const registry = options.views === undefined ? loaded : scopeToViews(loaded, options.views);
  const expected = buildFileSet(registry, options.outDir, options.renderers);

  const differing: string[] = [];
  for (const [path, contents] of [...expected].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const actual = await readIfExists(path);
    if (actual === null) differing.push(`missing: ${path}`);
    else if (actual !== contents) differing.push(`differs: ${path}`);
  }

  if (differing.length === 0) {
    console.log(`up to date — ${expected.size} file(s) match the registry`);
    return 0;
  }
  for (const line of differing) console.log(line);
  console.log(`${differing.length} of ${expected.size} file(s) would change`);
  return 1;
}
