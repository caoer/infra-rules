import { z } from "zod";
import { HostSchema } from "./host.ts";
import { MeshSchema } from "./mesh.ts";
import { NetworkSchema } from "./network.ts";
import { PolicySchema } from "./policy.ts";
import { ProxyExitSchema } from "./proxy-exit.ts";
import { ResolverSchema } from "./resolver.ts";
import { RouteTargetSchema } from "./route-target.ts";
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
  ResolverSchema,
  RouteTargetSchema,
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
  /**
   * Address space retired from the fleet. Any live datum inside one of these
   * ranges hard-fails validation (integrity `[retired-range]`). The REAL
   * ranges are fleet-private inventory detail, so they live here — in the
   * org's private data — never in engine code; the engine's built-in
   * `RETIRED_RANGES` holds fixture-space placeholders only.
   */
  retiredRanges: z.array(z.cidrv4()).optional(),
});

export type Registry = z.infer<typeof RegistrySchema>;
