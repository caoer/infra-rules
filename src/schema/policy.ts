import { z } from "zod";

/**
 * A routing policy target, declared as its own entity so the set of policies
 * is enumerable: routing entries reference one by `name`, and the integrity
 * layer (Unit 2) resolves those references against the declared set.
 */
export const PolicySchema = z.strictObject({
  kind: z.literal("policy"),
  name: z.string().min(1),
  description: z.string().optional(),
});

export type Policy = z.infer<typeof PolicySchema>;
