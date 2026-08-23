import { z } from "zod";

/**
 * A proxy exit endpoint. `host` is the exit's own address (IP or hostname),
 * not a host-entity reference — exits live outside the fleet.
 *
 * `method`/`password` are credentials: real values exist only in the
 * encrypted registry data file and its gitignored local plaintext. Anything
 * committed to this repo (fixtures, tests) uses obviously fake values; the
 * leak-guard test (Unit 2) enforces that mechanically.
 *
 * `password` may also be a consumer-side template (e.g. `${SERVER_PSK}:${USER_PSK}`
 * for a multi-user ss-2022 entry): the engine renders it verbatim and the
 * consumer substitutes after the render. The engine never reads secrets.
 *
 * Optional per-exit shape, read by the Surge renderer:
 * - `shadowTls` — the exit is reached through a shadow-tls v3 wrapper. Its
 *   `password` is the ONE shared handshake password (a credential, same rules
 *   as `password` above); `sni` is the camouflage server name.
 * - `extras` — Surge options appended after the credentials, one `key=value`
 *   per element. When present it REPLACES the layout-wide `proxyExtras` for
 *   this exit; `[]` is the explicit answer "no extras" (a shadow-tls exit is
 *   TCP-only, so `udp-relay=true` must not ride along by default).
 */
export const ShadowTlsSchema = z.strictObject({
  password: z.string().min(1),
  sni: z.hostname(),
  /** D4 scopes the entry to v3; the server module only speaks v3. */
  version: z.literal(3),
});

export type ShadowTls = z.infer<typeof ShadowTlsSchema>;

export const ProxyExitSchema = z.strictObject({
  kind: z.literal("proxyExit"),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  method: z.string().min(1),
  password: z.string().min(1),
  shadowTls: ShadowTlsSchema.optional(),
  extras: z.array(z.string().min(1)).optional(),
});

export type ProxyExit = z.infer<typeof ProxyExitSchema>;
