import { z } from "zod";

/**
 * Routing intent. Rule targets are first-match, and a more-specific range
 * sitting inside a broader catch-all range is silently swallowed when order
 * is wrong — so ordering is explicit data, never declaration order:
 *
 * - `intent` entries carry a required integer `priority`; lower emits
 *   earlier (the `ip rule` convention).
 * - `catch-all` entries are the broad covering ranges (D14): renderers emit
 *   them in an always-last pass, after every intent, whatever their
 *   priorities. Priority orders catch-alls only among themselves — and it is
 *   still load-bearing there, because catch-alls can nest (a /24 inside the
 *   /12 supernet must emit first). The match is cidr-only: a catch-all is a
 *   covering range by definition, and no renderer has a meaning for a
 *   domain-shaped one — the schema refuses what no renderer could emit.
 *
 * `orderRouting` is the canonical emission order; renderers import it rather
 * than re-deriving the sort. The type split IS the ordering guarantee: no
 * priority value can move an intent below a catch-all, so ordering never
 * rests on a human keeping one number the highest of a hand-edited list.
 */
export const RouteMatchSchema = z.discriminatedUnion("match", [
  z.strictObject({ match: z.literal("cidr"), cidr: z.cidrv4() }),
  z.strictObject({ match: z.literal("domain"), domain: z.hostname() }),
  z.strictObject({ match: z.literal("domain-suffix"), suffix: z.string().min(1) }),
]);

export type RouteMatch = z.infer<typeof RouteMatchSchema>;

export const RoutingIntentSchema = z.strictObject({
  kind: z.literal("routing"),
  entry: z.literal("intent"),
  name: z.string().min(1),
  match: RouteMatchSchema,
  /** Policy entity reference, by name. */
  policy: z.string().min(1),
  priority: z.number().int().nonnegative(),
  /**
   * Mesh entity reference, by name: the overlay whose address space this
   * intent's target range lives in. DECLARED, never derived — CIDR containment
   * cannot tell which mesh a range belongs to (separate overlays share one TUN
   * supernet), so a mesh-space target says so itself, and a target without the
   * field resolves through the policy mapping on every render target.
   *
   * The named entity may live in ANOTHER org's registry file: org files render
   * individually (a per-org repo renders from its own file only), so integrity
   * must not hard-fail the name being absent — `[routing-mesh]` checks the
   * range only against a mesh entity it can actually see.
   */
  mesh: z.string().min(1).optional(),
});

export const RoutingCatchAllSchema = z.strictObject({
  kind: z.literal("routing"),
  entry: z.literal("catch-all"),
  name: z.string().min(1),
  match: z.strictObject({ match: z.literal("cidr"), cidr: z.cidrv4() }),
  policy: z.string().min(1),
  priority: z.number().int().nonnegative(),
});

export const RoutingSchema = z.discriminatedUnion("entry", [
  RoutingIntentSchema,
  RoutingCatchAllSchema,
]);

export type RoutingIntent = z.infer<typeof RoutingIntentSchema>;
export type RoutingCatchAll = z.infer<typeof RoutingCatchAllSchema>;
export type Routing = z.infer<typeof RoutingSchema>;

/** Deterministic: priority ascending, name as tie-break (locale-independent). */
function byPriorityThenName(a: Routing, b: Routing): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Canonical emission order: every intent (by priority), then every catch-all (by priority). */
export function orderRouting<T extends Routing>(entries: readonly T[]): T[] {
  const intents = entries.filter((e) => e.entry === "intent");
  const catchAlls = entries.filter((e) => e.entry === "catch-all");
  return [...intents.sort(byPriorityThenName), ...catchAlls.sort(byPriorityThenName)];
}

/**
 * A render target's routing vocabulary. Membership is EXPLICIT data on the
 * target, never inferred from addresses (ZT ruling, 2026-08-14): a node with
 * sing-box rules "can be a mesh node which can route directly to 10.* ip. it
 * can also possible that it is not a mesh node so traffic go through the
 * proxy node."
 */
export interface RouteVocabulary {
  /**
   * Mesh entity name → the name of this target's direct/mesh path into that
   * overlay (a Surge policy group, a sing-box outbound tag — the target's own
   * vocabulary). A key's presence IS membership; `{}` declares a target that
   * is a member of nothing.
   */
  memberOf: Record<string, string>;
  /** Policy entity name → proxy group / outbound tag, same vocabulary. */
  policyMap: Record<string, string>;
}

/**
 * Membership-aware policy resolution — the one definition every renderer
 * shares. A target that is a MEMBER of the mesh an entry's range lives in
 * routes it over its own mesh path, whatever the policy says: the policy
 * names which detour reaches the range from OUTSIDE, and a member is inside.
 * Everything else — non-members, targets outside any mesh (LAN sites),
 * domain-shaped targets — resolves through the policy mapping.
 *
 * Returns `undefined` when the policy has no mapping; the caller refuses with
 * its own context, because a silently dropped entry is the exact failure
 * class this engine exists to kill.
 */
export function resolveRoute(entry: Routing, vocabulary: RouteVocabulary): string | undefined {
  const viaMembership =
    entry.entry === "intent" && entry.mesh !== undefined
      ? vocabulary.memberOf[entry.mesh]
      : undefined;
  return viaMembership ?? vocabulary.policyMap[entry.policy];
}
