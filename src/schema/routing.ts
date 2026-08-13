import { z } from "zod";

/**
 * Routing intent. Rule targets are first-match, and a more-specific range
 * sitting inside a broader catch-all range is silently swallowed when order
 * is wrong — so ordering is explicit data, never declaration order:
 *
 * - `intent` entries carry a required integer `priority`; lower emits
 *   earlier (the `ip rule` convention).
 * - `catch-all` entries are a separate variant with no match: renderers emit
 *   them in an always-last pass, after every intent, whatever their
 *   priorities. Priority orders catch-alls only among themselves.
 *
 * `orderRouting` is the canonical emission order; renderers import it rather
 * than re-deriving the sort.
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
});

export const RoutingCatchAllSchema = z.strictObject({
  kind: z.literal("routing"),
  entry: z.literal("catch-all"),
  name: z.string().min(1),
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
export function orderRouting(entries: readonly Routing[]): Routing[] {
  const intents = entries.filter((e) => e.entry === "intent");
  const catchAlls = entries.filter((e) => e.entry === "catch-all");
  return [...intents.sort(byPriorityThenName), ...catchAlls.sort(byPriorityThenName)];
}
