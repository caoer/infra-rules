/**
 * `render` — registry in, artifacts on disk out.
 *
 * The whole set is built and serialized in memory before anything is written,
 * so a renderer that throws leaves the output tree untouched.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { RegistrySchema, type Registry } from "../schema/registry.ts";
import { canonicalJson, stampHeader } from "../lib/canonical.ts";
import { writeAllOrNothing, writeFileAtomic, type FileSet } from "../lib/atomic-write.ts";
import { renderers as registeredRenderers, type Renderer } from "../render/index.ts";

export async function loadRegistry(path: string): Promise<Registry> {
  const text = await readFile(path, "utf8");
  return RegistrySchema.parse(JSON.parse(text));
}

/** Rejects paths that would escape the output root or collide across renderers. */
function resolveTarget(outDir: string, rendererName: string, relative: string): string {
  if (isAbsolute(relative) || normalize(relative).startsWith("..")) {
    throw new Error(`renderer "${rendererName}": path must stay inside the output root: ${relative}`);
  }
  return join(outDir, relative);
}

/** Everything the given renderers produce, canonicalized and header-stamped. */
export function buildFileSet(
  registry: Registry,
  outDir: string,
  rs: Renderer[] = registeredRenderers(),
): FileSet {
  const files: FileSet = new Map();
  const owner = new Map<string, string>();

  for (const renderer of rs) {
    for (const file of renderer.render(registry)) {
      const target = resolveTarget(outDir, renderer.name, file.path);
      const existing = owner.get(target);
      if (existing !== undefined) {
        throw new Error(
          `renderers "${existing}" and "${renderer.name}" both render ${file.path}`,
        );
      }
      owner.set(target, renderer.name);
      files.set(target, canonicalJson(stampHeader(file.value)));
    }
  }

  return files;
}

export interface RenderOptions {
  registryPath: string;
  outDir: string;
  renderers?: Renderer[];
  /**
   * Where to write the produced-set listing: one path per line, relative to
   * `outDir`, sorted. `"-"` means stdout.
   *
   * Consumers commit rendered artifacts, so a view removed from the registry
   * leaves its already-committed file tracked, unmodified and stale —
   * `git status` says nothing. This listing is the authority a regen recipe
   * diffs its output directory against, instead of maintaining an
   * expected-outputs list that drifts from the renderers.
   */
  producedListPath?: string;
}

/** Exit code per D18: 0 rendered, 2 failed. */
export async function runRender(options: RenderOptions): Promise<number> {
  const registry = await loadRegistry(options.registryPath);
  const files = buildFileSet(registry, options.outDir, options.renderers);
  await writeAllOrNothing(files);

  if (options.producedListPath !== undefined) {
    const listing = producedList(files, options.outDir);
    if (options.producedListPath === "-") console.log(listing);
    else await writeFileAtomic(options.producedListPath, `${listing}\n`);
  }

  console.error(`rendered ${files.size} file(s) to ${options.outDir}`);
  return 0;
}

/** The produced set as relative, forward-slashed, sorted paths. */
export function producedList(files: FileSet, outDir: string): string {
  return [...files.keys()]
    .map((path) => relative(outDir, path).split(sep).join("/"))
    .sort()
    .join("\n");
}
