/**
 * sing-box `routeRules` renderer — per-site routing for routeTarget entities
 * (closes the D13 gap).
 *
 * Emits `singbox/routerules-<target>.json`, body `{ routeRules: [...] }`, for
 * the existing gateway contract option ("Extra route rules inserted before
 * mesh/private catch-alls"). One rule per cidr-shaped routing INTENT, in
 * `orderRouting` order, resolved through the target's declared membership
 * (`resolveRoute`): a member of the intent's mesh routes it over its own mesh
 * path; everything else resolves through the target's `policyOutbounds`
 * detours. Rules are separate per site — the generated file mirrors the
 * registry's intent structure instead of collapsing ranges.
 *
 * SCOPE — cidr intents only, deliberately:
 * - Domain-shaped intents encode the NON-MEMBER eyeball view (which detour a
 *   node outside the mesh uses for a name). A gateway's domain routing is
 *   entangled with its own DNS chain and sniff rules, which live with the
 *   gateway's hand config; rendering the registry's domain intents under a
 *   gateway's hand domain rules would emit first-match-dead lines that look
 *   live. The per-site contract stays IP-shaped.
 * - Catch-all entries (D14) are not rendered: the gateway contract inserts
 *   these rules BEFORE its own mesh/private catch-alls, so emitting registry
 *   catch-alls here would hoist covering ranges above the consumer's.
 *
 * Output scoping: a routeTarget anchors to its org through its `resolver`
 * (the gateway's resolution surface). Under `--views`, a target whose
 * resolver lost ALL its views belongs to another org and is skipped; a
 * PARTIALLY filtered resolver is a hard error, same rule as the merged
 * dnsrules renderer — rendering under a truncated anchor would silently ship
 * one org's gateway file into another org's repo.
 */

import type { Registry, Entity } from "../schema/registry.ts";
import type { RoutingIntent } from "../schema/routing.ts";
import { orderRouting, resolveRoute } from "../schema/routing.ts";
import { registerRenderer, type RenderedFile } from "./index.ts";

function fail(message: string): never {
  throw new Error(`routerules: ${message}`);
}

type CidrIntent = RoutingIntent & { match: { match: "cidr"; cidr: string } };

function render(registry: Registry): RenderedFile[] {
  const entities = [...Object.values(registry.snapshots).flat(), ...registry.hand];
  const targets = entities.filter((entity) => entity.kind === "routeTarget");
  if (targets.length === 0) return [];

  const cidrIntents = orderRouting(
    entities.filter(
      (entity): entity is CidrIntent =>
        entity.kind === "routing" && entity.entry === "intent" && entity.match.match === "cidr",
    ),
  );
  if (cidrIntents.length === 0) {
    fail(
      `${targets.length} routeTarget(s) declared but the registry has no cidr routing intents — ` +
        `a target with nothing to render is dead config; remove the target or add the intents`,
    );
  }

  const declaredMeshes = new Set(
    cidrIntents.map((intent) => intent.mesh).filter((mesh): mesh is string => mesh !== undefined),
  );
  const resolvers = new Map(
    entities
      .filter((entity) => entity.kind === "resolver")
      .map((resolver) => [resolver.name, resolver]),
  );
  const views = new Set(
    entities.filter((entity) => entity.kind === "view").map((view) => view.name),
  );

  return [...targets]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((target) => {
      const resolver = resolvers.get(target.resolver);
      if (resolver === undefined) {
        fail(`routeTarget "${target.name}": resolver "${target.resolver}" not found — run validate`);
      }
      const present = resolver.views.filter((name) => views.has(name));
      if (present.length === 0) return []; // scoped out entirely — another org's target
      if (present.length < resolver.views.length) {
        const missing = resolver.views.filter((name) => !views.has(name));
        fail(
          `routeTarget "${target.name}" lost view(s) ${missing.join(", ")} of resolver ` +
            `"${target.resolver}" to --views scoping but kept ${present.join(", ")} — ` +
            `scope all of the resolver's views in, or none`,
        );
      }

      // A membership no intent declares is a dead key: either a typo'd mesh
      // name (which would silently demote the member to its proxy detours) or
      // config outliving the data. Both refuse.
      for (const mesh of Object.keys(target.memberOf)) {
        if (!declaredMeshes.has(mesh)) {
          fail(
            `routeTarget "${target.name}": memberOf names mesh "${mesh}" but no cidr routing ` +
              `intent declares it — a typo here would silently route mesh space through the ` +
              `proxy detours; fix the name or drop the membership`,
          );
        }
      }

      const routeRules = cidrIntents.map((intent) => {
        const outbound = resolveRoute(intent, {
          memberOf: target.memberOf,
          policyMap: target.policyOutbounds,
        });
        if (outbound === undefined) {
          fail(
            `routeTarget "${target.name}": intent "${intent.name}" resolves through policy ` +
              `"${intent.policy}" but policyOutbounds has no mapping for it — a silently ` +
              `dropped site would fall through to the gateway's catch-all`,
          );
        }
        return {
          ip_cidr: [intent.match.cidr],
          action: "route",
          outbound,
        };
      });

      return [{ path: `singbox/routerules-${target.name}.json`, value: { routeRules } }];
    });
}

export const routerulesRenderer = { name: "routerules", render };

registerRenderer(routerulesRenderer);
