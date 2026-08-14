/**
 * The renderer registry.
 *
 * ADDING A RENDERER — exactly one line in this file:
 *
 *     import "./probes.ts";      // ← in the REGISTRATIONS block at the bottom
 *
 * Your module calls `registerRenderer({ name, render })` at module scope; the
 * side-effect import above pulls it in. One line per renderer, alphabetical,
 * so renderer branches built in parallel merge without conflict.
 *
 * A renderer is a pure function from the registry to a set of files. It never
 * touches disk, never reads the clock: the harness serializes (canonical.ts)
 * and writes (atomic-write.ts).
 */

import type { Registry } from "../schema/registry.ts";
import type { JsonObject } from "../lib/canonical.ts";

/**
 * One rendered artifact. `path` is relative to the render output root and must
 * be relative and forward-slashed. `value` must be an object — the DO NOT EDIT
 * header needs a key to live under, so a list is wrapped in a named field.
 */
export interface RenderedFile {
  path: string;
  value: JsonObject;
}

export interface Renderer {
  /** Stable identifier, used in render order and in error messages. */
  name: string;
  render(registry: Registry): RenderedFile[];
}

// `var` (not `const`): renderer modules import this file while this file is
// still evaluating their side-effect imports below. Function declarations and
// `var` hoist, so `registerRenderer` works mid-cycle; a `const` store would be
// in its temporal dead zone.
var REGISTERED: Map<string, Renderer> | undefined;

export function registerRenderer(renderer: Renderer): void {
  REGISTERED ??= new Map();
  if (REGISTERED.has(renderer.name)) {
    throw new Error(`renderer "${renderer.name}" is registered twice`);
  }
  REGISTERED.set(renderer.name, renderer);
}

/** All registered renderers, name-sorted so render order never depends on import order. */
export function renderers(): Renderer[] {
  return [...(REGISTERED ?? new Map()).values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Test-only: drop every registration. */
export function resetRenderers(): void {
  REGISTERED = undefined;
}

// ── REGISTRATIONS ── one `import "./<file>.ts";` line per renderer, alphabetical.
import "./probes.ts";
import "./records.ts";
import "./routerules.ts";
import "./singbox.ts";
