import { z } from "zod";
import { AllocationSchema } from "./network.ts";

/**
 * An overlay mesh. Hosts join one by name (`host.mesh`) and carry their mesh
 * address in `host.easytier_ip`; the mesh entity itself holds the range and
 * its allocation vocabulary.
 */
export const MeshSchema = z.strictObject({
  kind: z.literal("mesh"),
  name: z.string().min(1),
  cidr: z.cidrv4().optional(),
  allocation: AllocationSchema.optional(),
  description: z.string().optional(),
});

export type Mesh = z.infer<typeof MeshSchema>;
