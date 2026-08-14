import { z } from "zod";

/**
 * A sing-box routing render target: one node whose route rules are rendered
 * from the registry's routing intents (`render/routerules.ts` emits
 * `singbox/routerules-<name>.json` for each).
 *
 * Mesh membership is the target's FIRST-CLASS attribute (ZT ruling,
 * 2026-08-14): a `memberOf` key is a declaration that this node sits inside
 * that overlay and reaches its address space directly; the value names the
 * node's own path for it (a sing-box outbound tag — "direct", or a selector
 * that defaults to direct). `{}` declares a node that is a member of nothing:
 * every intent then resolves through `policyOutbounds`, the proxy detours.
 * Membership is never inferred from addresses — separate overlays share TUN
 * supernets, so containment cannot answer it (see routing.ts).
 *
 * `resolver` anchors the target to its org for `--views` output scoping: the
 * merged fleet envelope carries every org's targets, and a per-org repo must
 * not receive another org's gateway files (lib/scope.ts). A routing target is
 * a gateway, and a gateway already declares its resolution surface — the
 * resolver's view list is the org anchor, exactly as the merged dnsrules
 * renderer uses it.
 */
export const RouteTargetSchema = z.strictObject({
  kind: z.literal("routeTarget"),
  name: z.string().min(1),
  /** Resolver entity reference, by name — the org anchor for output scoping. */
  resolver: z.string().min(1),
  /** Mesh entity name → outbound tag of this node's direct path into it. */
  memberOf: z.record(z.string().min(1), z.string().min(1)),
  /** Policy entity name → outbound tag (the node's proxy detours). */
  policyOutbounds: z.record(z.string().min(1), z.string().min(1)),
  description: z.string().optional(),
});

export type RouteTarget = z.infer<typeof RouteTargetSchema>;
