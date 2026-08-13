import { z } from "zod";
import { HostSchema } from "./host.ts";
import { MeshSchema } from "./mesh.ts";
import { NetworkSchema } from "./network.ts";
import { PolicySchema } from "./policy.ts";
import { ProxyExitSchema } from "./proxy-exit.ts";
import { RoutingSchema } from "./routing.ts";
import { ServiceSchema } from "./service.ts";
import { ViewSchema } from "./view.ts";

/** Any registry entity; `kind` discriminates. */
export const EntitySchema = z.discriminatedUnion("kind", [
  HostSchema,
  NetworkSchema,
  MeshSchema,
  ViewSchema,
  PolicySchema,
  ServiceSchema,
  RoutingSchema,
  ProxyExitSchema,
]);

export type Entity = z.infer<typeof EntitySchema>;

/**
 * Bump on any breaking shape change; consumers assert it before merging or
 * rendering. A literal (not `z.number()`) so an engine/data version mismatch
 * is a parse error, not a silent read.
 */
export const SCHEMA_VERSION = 1;

/**
 * The registry envelope. `snapshots` holds machine-exported entities keyed
 * by org; `hand` holds hand-maintained entities. They are separate sections
 * so the duplicate-entity check (Unit 2, D4) can compare them: the same
 * entity appearing in both is an error, never a silent precedence.
 */
export const RegistrySchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  snapshots: z.record(z.string().min(1), z.array(EntitySchema)),
  hand: z.array(EntitySchema),
});

export type Registry = z.infer<typeof RegistrySchema>;
