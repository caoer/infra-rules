import { z } from "zod";

/**
 * A resolver is a gateway's resolution surface: the ORDERED list of views it
 * consults. For each service name the merged render answers from the first
 * view in this list that answers (`answerFor`); later views are consulted
 * only for names the earlier ones do not serve at all.
 *
 * The order is consumer intent, declared here — never derived from D12's
 * viewRank, which orders artifact listings, not answer precedence.
 *
 * Names that answer in MORE THAN ONE of a resolver's views must carry a
 * `service.views` declaration (integrity `[resolver-ambiguous]`), so the
 * precedence pick is always backed by declared intent, and a name dropping
 * out of its declared view is a refusal (`[service-views]`), never a silent
 * promotion of the next view's answer.
 */
export const ResolverSchema = z.strictObject({
  kind: z.literal("resolver"),
  name: z.string().min(1),
  /** View entity names, highest precedence first. */
  views: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
});

export type Resolver = z.infer<typeof ResolverSchema>;
