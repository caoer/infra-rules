import { z } from "zod";
import type { Host } from "./host.ts";

/**
 * A view is a resolution vantage, scoped to exactly one mesh or one network.
 * Per-view answers are COMPUTED from host address data by `answerFor` — they
 * are never stored, and a view never borrows another view's answer.
 */
export const ViewScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mesh"), mesh: z.string().min(1) }),
  z.strictObject({ kind: z.literal("network"), network: z.string().min(1) }),
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
 * - network-scoped view → the host's address on that same network.
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
  }
}
