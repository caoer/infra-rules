import { z } from "zod";

/**
 * The two address-allocation vocabularies, kept apart by discriminant:
 * - `org-site-band` — an org hierarchy (org → site → band).
 * - `owner-subnet` — an owner model (owner → subnet).
 * The discriminated union makes mixing fields from both a parse error;
 * conflating them is not representable.
 */
export const CosAllocationSchema = z.strictObject({
  vocabulary: z.literal("org-site-band"),
  org: z.string().min(1),
  site: z.string().min(1),
  band: z.number().int().nonnegative().optional(),
});

export const LocusAllocationSchema = z.strictObject({
  vocabulary: z.literal("owner-subnet"),
  owner: z.string().min(1),
  subnet: z.cidrv4(),
});

export const AllocationSchema = z.discriminatedUnion("vocabulary", [
  CosAllocationSchema,
  LocusAllocationSchema,
]);

export type Allocation = z.infer<typeof AllocationSchema>;

/**
 * A LAN / routed subnet. `cidr` is format-checked only — containment,
 * overlap, and retired-range enforcement are the integrity layer's job
 * (Unit 2), so ranges outside any supernet validate here by design.
 */
export const NetworkSchema = z.strictObject({
  kind: z.literal("network"),
  name: z.string().min(1),
  cidr: z.cidrv4(),
  allocation: AllocationSchema.optional(),
  description: z.string().optional(),
});

export type Network = z.infer<typeof NetworkSchema>;
