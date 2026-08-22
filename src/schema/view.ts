import { z } from "zod";
import type { Host } from "./host.ts";
import { isHostService, type Service, type StaticAnswer } from "./service.ts";

/**
 * A view is a resolution vantage, scoped to exactly one mesh, one network, or
 * the public internet. Per-view answers are COMPUTED from host address data
 * by `answerFor` — they are never stored, and a view never borrows another
 * view's answer. A `public` view has no address data to compute from: it
 * answers only static-answer services (`answerIn`).
 */
export const ViewScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mesh"), mesh: z.string().min(1) }),
  z.strictObject({ kind: z.literal("network"), network: z.string().min(1) }),
  z.strictObject({ kind: z.literal("public") }),
]);

export type ViewScope = z.infer<typeof ViewScopeSchema>;

export const ViewSchema = z.strictObject({
  kind: z.literal("view"),
  name: z.string().min(1),
  scope: ViewScopeSchema,
  description: z.string().optional(),
});

export type View = z.infer<typeof ViewSchema>;

/**
 * The one lawful way to answer "what IP does `host` have in `view`?".
 *
 * - mesh-scoped view  → the host's `easytier_ip`, only if the host is a
 *   member of that same mesh;
 * - network-scoped view → the host's address on that same network;
 * - public view → never: a host's addresses are mesh or LAN vantages, and
 *   a public name is a static declaration, not a lookup.
 *
 * `undefined` means "no answer for this view": the caller OMITS the record.
 * Falling back to another view's address is not expressible here — each
 * branch of the exhaustive switch can reach only its own scope's address
 * field, and there is no default path.
 */
export function answerFor(view: View, host: Host): string | undefined {
  const scope = view.scope;
  switch (scope.kind) {
    case "mesh":
      return host.mesh === scope.mesh ? host.easytier_ip : undefined;
    case "network":
      return host.networks?.[scope.network]?.ip;
    case "public":
      return undefined;
  }
}

/** What a name answers in a view: the record type and value, plus the host
 * it was computed from when there is one. */
export type Answer = StaticAnswer & { host?: string };

/**
 * The one lawful way to answer "what does `service` answer in `view`?" —
 * both service forms, one omit rule:
 *
 * - host-backed → `answerFor(view, host)` as an A record, or no answer;
 * - static      → its literal answer in a `public` view, or no answer.
 *
 * `host` is the resolved host entity for a host-backed service; the caller
 * owns the lookup (and decides whether a dangling reference throws or
 * skips). It is ignored for a static service. `undefined` means OMIT.
 */
export function answerIn(view: View, service: Service, host: Host | undefined): Answer | undefined {
  if (!isHostService(service)) {
    return view.scope.kind === "public" ? service.answer : undefined;
  }
  if (host === undefined) return undefined;
  const address = answerFor(view, host);
  return address === undefined ? undefined : { type: "A", value: address, host: host.name };
}
