/**
 * Output scoping.
 *
 * The registry is deliberately cross-org on the INPUT side: global kind+name
 * uniqueness is what makes D4's duplicate check work, so validate has to see
 * every org at once. Output is the opposite. Rendered artifacts are committed
 * into per-org repos, and one org's names, LAN addresses and service checks
 * must never land in another org's repo — a push cannot be recalled.
 *
 * Nothing in the schema ties a view to an org, and inferring that link would
 * be guessing. So scoping is an explicit allowlist of view names, supplied by
 * the caller that owns the output directory. Unknown names are a hard error:
 * a typo must fail loud, because a correct render can legitimately be empty
 * (a repo with no views of its own) and "produced nothing" would otherwise be
 * indistinguishable from "produced someone else's data".
 */

import type { Registry, Entity } from "../schema/registry.ts";

export class UnknownViewError extends Error {}

/**
 * Return `registry` with its view entities narrowed to `viewNames`.
 *
 * Every renderer derives its output from the views it can see, so filtering
 * the input is what makes scoping uniform across renderers present and
 * future — no renderer has to remember to honour a flag.
 */
export function scopeToViews(registry: Registry, viewNames: readonly string[]): Registry {
  const wanted = new Set(viewNames);

  const known = new Set<string>();
  for (const entity of allEntities(registry)) {
    if (entity.kind === "view") known.add(entity.name);
  }

  const unknown = [...wanted].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0) {
    throw new UnknownViewError(
      `unknown view(s): ${unknown.join(", ")}. ` +
        `known views: ${[...known].sort().join(", ") || "(none in this registry)"}`,
    );
  }

  const keep = (entities: Entity[]): Entity[] =>
    entities.filter((entity) => entity.kind !== "view" || wanted.has(entity.name));

  return {
    ...registry,
    snapshots: Object.fromEntries(
      Object.entries(registry.snapshots).map(([org, entities]) => [org, keep(entities)]),
    ),
    hand: keep(registry.hand),
  };
}

function* allEntities(registry: Registry): Generator<Entity> {
  for (const entities of Object.values(registry.snapshots)) yield* entities;
  yield* registry.hand;
}
