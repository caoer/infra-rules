import { z } from "zod";

/**
 * A proxy exit endpoint. `host` is the exit's own address (IP or hostname),
 * not a host-entity reference — exits live outside the fleet.
 *
 * `method`/`password` are credentials: real values exist only in the
 * encrypted registry data file and its gitignored local plaintext. Anything
 * committed to this repo (fixtures, tests) uses obviously fake values; the
 * leak-guard test (Unit 2) enforces that mechanically.
 */
export const ProxyExitSchema = z.strictObject({
  kind: z.literal("proxyExit"),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  method: z.string().min(1),
  password: z.string().min(1),
});

export type ProxyExit = z.infer<typeof ProxyExitSchema>;
