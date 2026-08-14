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
 * `region` is a PROXIMITY LABEL and may appear on ANY host.
 *
 * It was originally gated to jumper/exit roles, from a carried finding that
 * observed region on jumper data and read that as a rule. The the inventory repo
 * inventory disproves it: ordinary bare-metal hosts carry `region = "east-1"`,
 * `"west-1"`, `"east-2"`, `"north-1"` beside `location`, with no roles field at all
 * (the inventory's bare-metal group). The gate made the live client
 * profile's region-grouped host pins underivable from the registry — the
 * data existed and the schema refused it.
 *
 * `source` records WHICH exporter path produced a snapshot entity, so a
 * renderer reproducing an existing artifact byte-for-byte can select the
 * same host set its predecessor saw. Without it, an entity present only in a
 * broader export silently adds output lines to a file whose value is being
 * byte-diffed.
 */
/**
 * Canonical `source` values.
 *
 * This string is a CONTRACT between two units that never speak directly: the
 * the inventory repo data exporter writes it, and the client-profile renderer filters on it. A
 * disagreement ("ssh_inventory" vs "ssh-inventory") makes the filter select
 * nothing, and a renderer that silently emits an empty host set is the exact
 * failure this whole design exists to prevent. Both sides import from here.
 */
export const HOST_SOURCE = {
  /** Hosts from the SSH inventory (`the SSH inventory`) — the set
   * `the legacy mesh generator` evaluated, i.e. the byte-identity set. */
  sshInventory: "ssh-inventory",
  /** Hosts contributed by the mesh.nix overlay; in the registry, not in the
   * pre-cutover client profile. */
  meshOverlay: "mesh-overlay",
} as const;

export type HostSource = (typeof HOST_SOURCE)[keyof typeof HOST_SOURCE];

export const HOST_SOURCES: readonly string[] = Object.values(HOST_SOURCE);

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
    /** Proximity label (e.g. "east-1", "west-1"). Any host may carry one. */
    region: z.string().min(1).optional(),
    /** Producing export path, e.g. "ssh-inventory" or "mesh-overlay".
     * Set by data exporters; absent on hand entities. */
    source: z.string().min(1).optional(),
    /** Source-fidelity fields (the org vocabulary); no v1 renderer reads them. */
    site: z.string().optional(),
    hypervisor: z.string().optional(),
    resources: z.unknown().optional(),
  });

export type Host = z.infer<typeof HostSchema>;
