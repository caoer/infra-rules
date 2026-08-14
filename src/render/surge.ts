/**
 * Surge dconf renderer (Unit 13).
 *
 * Renders the mesh routing unit of a Surge profile: an SS `[Proxy]` block
 * from proxyExit entities, per-host `/32` pins grouped by region, the
 * always-last catch-all ranges (D14), and a `[Host]` block mirroring the
 * overlay's magic DNS (`<name><hostSuffix>`). The output replaces a hand-rolled
 * per-fleet generator; its acceptance is byte-parity with that generator's
 * artifact (D19), so the line layout below is deliberately faithful to it.
 *
 * NOT in the renderer registry (`render/index.ts`) on purpose: this artifact
 * carries proxy credentials, so it must never be emitted into the generic
 * `render --out` tree that consuming repos commit. It renders only through
 * the explicit `render-surge` CLI command, to an explicit output path.
 *
 * Everything fleet-specific that is not registry data — region display
 * order, region→jumper assignment, spare exits, the Surge policy-group
 * names, the extra flags appended to proxy lines — comes from a LAYOUT
 * file supplied by the caller. The engine repo is public; fleet vocabulary
 * lives in the consuming repo's layout file and in the registry, never
 * here. `fixtures/surge-layout.json` is a synthetic example.
 *
 * Host selection (byte-parity contract): mesh members are hosts whose
 * `mesh` names the registry's single owner-subnet mesh, restricted to
 * `source === HOST_SOURCE.sshInventory` — the exact set the predecessor
 * generator evaluated. Broader-provenance hosts (`mesh-overlay`) stay in
 * the registry for other renderers but must not add lines to a file whose
 * safety property is "nothing changed". An EMPTY selection always throws:
 * a Surge render with no hosts is never a correct answer, and empty output
 * is indistinguishable from correct output until someone diffs it against
 * reality (the failure class this unit exists to close).
 */

import { z } from "zod";
import type { Registry, Entity } from "../schema/registry.ts";
import { HOST_SOURCE, type Host } from "../schema/host.ts";
import type { ProxyExit } from "../schema/proxy-exit.ts";
import type { Routing, RoutingIntent } from "../schema/routing.ts";
import { orderRouting } from "../schema/routing.ts";
import { ipToUint32 } from "../lib/cidr.ts";

/**
 * Presentation contract for one rendered profile. All fields are required:
 * a defaulted field would let a half-written layout render plausibly.
 */
export const SurgeLayoutSchema = z
  .strictObject({
    /** Region display order for pin groups and jumper `[Proxy]` lines. */
    regionOrder: z.array(z.string().min(1)).min(1),
    /** region → proxyExit name serving it. Keys must equal regionOrder. */
    jumpers: z.record(z.string().min(1), z.string().min(1)),
    /** proxyExit names emitted after the jumpers (manual-failover spares). */
    spares: z.array(z.string().min(1)),
    /** Flags appended verbatim to every `[Proxy]` line. */
    proxyExtras: z.string().min(1),
    /** DNS suffix for `[Host]` entries (the overlay's magic-DNS domain,
     * e.g. ".example.test") — fleet-specific, so caller-supplied like every
     * other real-world name in this contract. */
    hostSuffix: z.string().min(2).startsWith("."),
    /** registry policy name → Surge policy-group name. */
    policyGroups: z.record(z.string().min(1), z.string().min(1)),
    /** Registry policy the `/32` pins route to. */
    pinPolicy: z.string().min(1),
    /** Names of the routing entries emitted as the always-last catch-alls. */
    catchAlls: z.array(z.string().min(1)).min(1),
  })
  .superRefine((layout, ctx) => {
    const regions = new Set(layout.regionOrder);
    if (regions.size !== layout.regionOrder.length) {
      ctx.addIssue({ code: "custom", path: ["regionOrder"], message: "regionOrder has duplicates" });
    }
    for (const region of layout.regionOrder) {
      if (layout.jumpers[region] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["jumpers"],
          message: `region "${region}" has no jumper`,
        });
      }
    }
    for (const region of Object.keys(layout.jumpers)) {
      if (!regions.has(region)) {
        ctx.addIssue({
          code: "custom",
          path: ["jumpers"],
          message: `jumper region "${region}" is not in regionOrder`,
        });
      }
    }
    const jumperNames = new Set(Object.values(layout.jumpers));
    for (const spare of layout.spares) {
      if (jumperNames.has(spare)) {
        ctx.addIssue({
          code: "custom",
          path: ["spares"],
          message: `"${spare}" is both a jumper and a spare`,
        });
      }
    }
  });

export type SurgeLayout = z.infer<typeof SurgeLayoutSchema>;

export interface SurgeStats {
  proxies: number;
  pins: number;
  pinRegions: number;
  unmapped: number;
  catchAlls: number;
  hosts: number;
}

/** A rendered profile plus the counts the CLI reports. */
export interface SurgeRender {
  text: string;
  stats: SurgeStats;
}

function fail(message: string): never {
  throw new Error(`surge: ${message}`);
}

function allEntities(registry: Registry): Entity[] {
  return [...Object.values(registry.snapshots).flat(), ...registry.hand];
}

/** The registry's single owner-subnet mesh — the overlay this file routes. */
function ownerSubnetMesh(entities: readonly Entity[]) {
  const meshes = entities.filter(
    (entity) => entity.kind === "mesh" && entity.allocation?.vocabulary === "owner-subnet",
  );
  if (meshes.length === 0) fail("registry has no owner-subnet mesh entity — nothing to render");
  if (meshes.length > 1) {
    fail(
      `registry has ${meshes.length} owner-subnet meshes (${meshes
        .map((mesh) => mesh.name)
        .join(", ")}) — the Surge unit renders exactly one`,
    );
  }
  return meshes[0]!;
}

type Member = Host & { easytier_ip: string };

const byIp = (a: Member, b: Member): number => ipToUint32(a.easytier_ip) - ipToUint32(b.easytier_ip);

export function renderSurge(registry: Registry, layout: SurgeLayout): SurgeRender {
  const entities = allEntities(registry);
  const mesh = ownerSubnetMesh(entities);

  const members = entities.filter(
    (entity): entity is Member =>
      entity.kind === "host" &&
      entity.source === HOST_SOURCE.sshInventory &&
      entity.mesh === mesh.name &&
      entity.easytier_ip !== undefined,
  );
  if (members.length === 0) {
    fail(
      `no hosts matched mesh "${mesh.name}" with source "${HOST_SOURCE.sshInventory}" — ` +
        `an empty render is never correct. Either the registry export lost its source ` +
        `field or the HOST_SOURCE contract drifted; refusing to emit an empty profile`,
    );
  }

  const group = (policyName: string, where: string): string => {
    const groupName = layout.policyGroups[policyName];
    if (groupName === undefined) {
      fail(`${where}: policy "${policyName}" has no policyGroups mapping in the layout`);
    }
    return groupName;
  };
  const pinGroup = group(layout.pinPolicy, "pinPolicy");

  // ── proxies: jumpers in region order, then spares — every exit accounted for
  const exits = new Map<string, ProxyExit>(
    entities.filter((entity) => entity.kind === "proxyExit").map((exit) => [exit.name, exit]),
  );
  const orderedExitNames = [
    ...layout.regionOrder.map((region) => layout.jumpers[region]!),
    ...layout.spares,
  ];
  const proxies = orderedExitNames.map((name) => {
    const exit = exits.get(name);
    if (exit === undefined) fail(`layout names proxyExit "${name}" but the registry has none`);
    return exit;
  });
  const unassigned = [...exits.keys()].filter((name) => !orderedExitNames.includes(name)).sort();
  if (unassigned.length > 0) {
    fail(
      `proxyExit(s) not assigned by the layout: ${unassigned.join(", ")} — ` +
        `every exit is a jumper or a spare; a silently dropped exit would vanish from the profile`,
    );
  }

  // ── pins vs unmapped: region membership decides, layout order groups
  const regionRank = new Map(layout.regionOrder.map((region, index) => [region, index]));
  const pins = members
    .filter((member) => member.region !== undefined && regionRank.has(member.region))
    .sort((a, b) => regionRank.get(a.region!)! - regionRank.get(b.region!)! || byIp(a, b));
  const unmapped = members
    .filter((member) => member.region === undefined || !regionRank.has(member.region))
    .sort(byIp);

  // ── catch-alls: layout-named routing entries, priority-ordered, always last
  const routing = new Map<string, Routing>(
    entities.filter((entity) => entity.kind === "routing").map((entry) => [entry.name, entry]),
  );
  const catchAlls = orderRouting(
    layout.catchAlls.map((name) => {
      const entry = routing.get(name);
      if (entry === undefined) fail(`layout names catch-all "${name}" but the registry has none`);
      return entry;
    }),
  ).map((entry) => {
    if (entry.entry !== "intent" || entry.match.match !== "cidr") {
      fail(`catch-all "${entry.name}" is not a cidr routing intent — cannot render as IP-CIDR`);
    }
    return entry as RoutingIntent & { match: { match: "cidr"; cidr: string } };
  });

  // ── emit — layout mirrors the predecessor generator line-for-line, so the
  // comment-stripped byte-diff (D19) compares structurally identical bodies.
  const lines: string[] = [];
  lines.push("# GENERATED by infra-rules render-surge — do not edit; regenerate from the registry");
  lines.push("# Layout (grouping, policy-group names, proxy extras) comes from the --layout file.");
  lines.push("");

  lines.push("[Proxy]");
  lines.push("# Proxy exits: jumpers in region order, then spares");
  for (const exit of proxies) {
    lines.push(
      `${exit.name} = ss, ${exit.host}, ${exit.port}, encrypt-method=${exit.method}, ` +
        `password="${exit.password}", ${layout.proxyExtras}`,
    );
  }
  lines.push("");

  lines.push("[Rule]");
  lines.push(
    `# Per-host /32 pins grouped by region (restore documentation); pins route via ${pinGroup}`,
  );
  lines.push("");

  for (const region of layout.regionOrder) {
    const regionPins = pins.filter((pin) => pin.region === region);
    if (regionPins.length === 0) continue;
    lines.push(`# ${region.toUpperCase()} (jumper on restore: ${layout.jumpers[region]!})`);
    for (const pin of regionPins) {
      lines.push(`IP-CIDR,${pin.easytier_ip}/32,${pinGroup},no-resolve // ${pin.name}`);
    }
    lines.push("");
  }

  if (unmapped.length > 0) {
    lines.push("# No regional jumper (region unset or unlisted) → catch-all below:");
    for (const member of unmapped) {
      lines.push(`#   ${member.easytier_ip}  ${member.name}`);
    }
    lines.push("");
  }

  lines.push("# Mesh catch-all ranges — always after the per-host pins (Surge [Rule] is first-match)");
  catchAlls.forEach((entry, index) => {
    if (catchAlls.length > 1 && index === catchAlls.length - 1) {
      lines.push(
        "# The final range contains the pins above; placed above them it would shadow every per-host override.",
      );
    }
    lines.push(`IP-CIDR,${entry.match.cidr},${group(entry.policy, `catch-all "${entry.name}"`)},no-resolve`);
  });
  lines.push("");

  lines.push("[Host]");
  lines.push(`# Mesh magic-DNS parity (<name>${layout.hostSuffix} → mesh IP)`);
  for (const member of [...members].sort(byIp)) {
    lines.push(`${member.name}${layout.hostSuffix} = ${member.easytier_ip}`);
  }
  lines.push("");

  return {
    text: lines.join("\n"),
    stats: {
      proxies: proxies.length,
      pins: pins.length,
      pinRegions: new Set(pins.map((pin) => pin.region)).size,
      unmapped: unmapped.length,
      catchAlls: catchAlls.length,
      hosts: members.length,
    },
  };
}

/**
 * The tier-1 strip (D19): drop whole comment lines and the entire `[Proxy]`
 * section from a rendered profile, keeping everything else byte-for-byte —
 * inline ` // host` comments are content and survive, so the golden still
 * verifies every host↔IP association. The committed golden is stored
 * already-stripped; the tier-1 test strips the fresh render with THIS
 * function, so both sides of the compare share one definition of "stripped".
 */
export function tier1Strip(text: string): string {
  const kept: string[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (/^\[.+\]$/.test(line)) section = line;
    if (section === "[Proxy]") continue;
    if (line.startsWith("#")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}
