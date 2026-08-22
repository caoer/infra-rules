/**
 * Surge dconf renderer (Unit 13).
 *
 * Renders the mesh routing unit of a Surge profile: an SS `[Proxy]` block
 * from proxyExit entities, per-host `/32` pins grouped by region, the
 * membership-resolved routing intents (site ranges, LAN sites, domains), the
 * always-last catch-all ranges (D14), and a `[Host]` block mirroring the
 * overlay's magic DNS (`<name><hostSuffix>`). The output replaces a hand-rolled
 * per-fleet generator; its acceptance was byte-parity with that generator's
 * artifact (D19) — the intents section is the first deliberate content change
 * past it, accepted by semantic parity with the hand rules it replaces.
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
import type { Routing, RoutingCatchAll } from "../schema/routing.ts";
import { orderRouting, resolveRoute } from "../schema/routing.ts";
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
    /**
     * Mesh entity name → Surge policy group of this profile's direct path
     * into that overlay. Membership is EXPLICIT and first-class: `{}`
     * declares a profile whose node is a member of NOTHING — every routing
     * intent then resolves through `policyGroups`, the proxy detours (a
     * Surge client outside the mesh reaches mesh space through a gateway).
     * Required, never defaulted: non-membership is a statement, not an
     * omission.
     */
    memberOf: z.record(z.string().min(1), z.string().min(1)),
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
    // Duplicate exit names would emit duplicate [Proxy] lines, and Surge
    // partially applies an invalid profile rather than refusing it — so
    // duplicates are a hard error naming both sources (D4), never a silent
    // dedup that hides which hand edit was wrong.
    const jumperRegionOf = new Map<string, string>();
    for (const region of layout.regionOrder) {
      const jumper = layout.jumpers[region];
      if (jumper === undefined) continue; // uncovered region already reported above
      const first = jumperRegionOf.get(jumper);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["jumpers", region],
          message: `regions "${first}" and "${region}" both name jumper "${jumper}" — duplicate [Proxy] line`,
        });
      } else {
        jumperRegionOf.set(jumper, region);
      }
    }
    const seenSpares = new Set<string>();
    for (const spare of layout.spares) {
      if (jumperRegionOf.has(spare)) {
        ctx.addIssue({
          code: "custom",
          path: ["spares"],
          message: `"${spare}" is both a jumper and a spare`,
        });
      }
      if (seenSpares.has(spare)) {
        ctx.addIssue({
          code: "custom",
          path: ["spares"],
          message: `spare "${spare}" is listed twice — duplicate [Proxy] line`,
        });
      }
      seenSpares.add(spare);
    }
  });

export type SurgeLayout = z.infer<typeof SurgeLayoutSchema>;

export interface SurgeStats {
  proxies: number;
  pins: number;
  pinRegions: number;
  unmapped: number;
  intents: number;
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

/**
 * One `[Proxy]` line. Shape: `name = ss, host, port, encrypt-method=…,
 * password="…"[, shadow-tls-password="…", shadow-tls-sni=…, shadow-tls-version=3]
 * [, extras…]`. Per-exit `extras` replace the layout-wide `proxyExtras`;
 * absent, the layout string rides verbatim (byte parity with the
 * predecessor generator, D19).
 */
export function proxyLine(exit: ProxyExit, layout: SurgeLayout): string {
  const parts = [
    `${exit.name} = ss`,
    exit.host,
    String(exit.port),
    `encrypt-method=${exit.method}`,
    `password="${exit.password}"`,
  ];
  if (exit.shadowTls !== undefined) {
    parts.push(
      `shadow-tls-password="${exit.shadowTls.password}"`,
      `shadow-tls-sni=${exit.shadowTls.sni}`,
      `shadow-tls-version=${exit.shadowTls.version}`,
    );
  }
  parts.push(...(exit.extras ?? [layout.proxyExtras]));
  return parts.join(", ");
}

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

  // ── routing intents: every `entry:"intent"` entity, membership-resolved.
  // The registry keeps intents abstract (range → policy); THIS profile's
  // memberOf decides how each resolves — a member routes a mesh-space range
  // over its own path into that overlay, a non-member (memberOf {}) detours
  // through the policy's proxy group. Emitted between the per-host pins
  // (most-specific overrides stay strongest) and the always-last catch-alls.
  const intents = orderRouting(
    entities.filter(
      (entity): entity is Routing & { entry: "intent" } =>
        entity.kind === "routing" && entity.entry === "intent",
    ),
  );
  const intentGroup = (entry: Routing & { entry: "intent" }): string => {
    const groupName = resolveRoute(entry, {
      memberOf: layout.memberOf,
      policyMap: layout.policyGroups,
    });
    if (groupName === undefined) {
      fail(
        `intent "${entry.name}": policy "${entry.policy}" has no policyGroups mapping in the layout`,
      );
    }
    return groupName;
  };
  const intentLine = (entry: Routing & { entry: "intent" }): string => {
    const groupName = intentGroup(entry);
    switch (entry.match.match) {
      case "cidr":
        return `IP-CIDR,${entry.match.cidr},${groupName},no-resolve`;
      case "domain":
        return `DOMAIN,${entry.match.domain},${groupName}`;
      case "domain-suffix":
        return `DOMAIN-SUFFIX,${entry.match.suffix},${groupName}`;
    }
  };

  // ── catch-alls: every `entry:"catch-all"` routing entity, priority-ordered
  // among themselves, emitted in the always-last pass (D14). Membership is
  // the entry type in the registry — data, not a layout name list — so no
  // hand-kept priority or allowlist decides what lands below what.
  const catchAlls = orderRouting(
    entities.filter(
      (entity): entity is RoutingCatchAll => entity.kind === "routing" && entity.entry === "catch-all",
    ),
  );
  if (catchAlls.length === 0) {
    fail(
      `registry has no catch-all routing entries — a profile without its covering ranges ` +
        `silently stops routing the mesh space; an empty catch-all set is never correct`,
    );
  }

  // ── emit — layout mirrors the predecessor generator line-for-line, so the
  // comment-stripped byte-diff (D19) compares structurally identical bodies.
  const lines: string[] = [];
  lines.push("# GENERATED by infra-rules render-surge — do not edit; regenerate from the registry");
  lines.push("# Layout (grouping, policy-group names, proxy extras) comes from the --layout file.");
  lines.push("");

  lines.push("[Proxy]");
  lines.push("# Proxy exits: jumpers in region order, then spares");
  for (const exit of proxies) {
    lines.push(proxyLine(exit, layout));
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

  if (intents.length > 0) {
    lines.push(
      "# Routing intents (site ranges, LAN sites, domains) — membership-resolved via the layout",
    );
    for (const entry of intents) {
      lines.push(intentLine(entry));
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
      intents: intents.length,
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
