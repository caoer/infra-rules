import { z } from "zod";

/**
 * A machine in the fleet. One entry per host, in a snapshot section (exported
 * from a source repo) or the hand section.
 *
 * Address model, read by view.ts `answerFor`:
 * - `easytier_ip` — the host's mesh address. This is the real source field
 *   name; never rename to `et_ip`.
 * - `networks` — LAN membership: network name → the host's address on it.
 *   A host absent from a network simply has no entry for it.
 *
 * `region` exists only on jumper/exit hosts — enforced here, not in prose.
 */
export const HostSchema = z
  .strictObject({
    kind: z.literal("host"),
    name: z.string().min(1),
    /** Free vocabulary; "jumper" and "exit" gate the `region` field. */
    roles: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    /** Mesh membership, by mesh entity name. */
    mesh: z.string().min(1).optional(),
    easytier_ip: z.ipv4().optional(),
    networks: z.record(z.string().min(1), z.strictObject({ ip: z.ipv4() })).optional(),
    region: z.string().min(1).optional(),
    /** Source-fidelity fields (the org vocabulary); no v1 renderer reads them. */
    site: z.string().optional(),
    hypervisor: z.string().optional(),
    resources: z.unknown().optional(),
  })
  .superRefine((host, ctx) => {
    if (host.region === undefined) return;
    const roles = host.roles ?? [];
    if (!roles.includes("jumper") && !roles.includes("exit")) {
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: `host "${host.name}": region exists only on jumper/exit hosts`,
      });
    }
  });

export type Host = z.infer<typeof HostSchema>;
