/**
 * Surge dconf renderer (Unit 13).
 *
 * Renders the mesh routing unit of a Surge profile: an SS `[Proxy]` block
 * from proxyExit entities, per-host `/32` pins grouped by region, the
 * membership-resolved routing intents (site ranges, LAN sites, domains), the
 * always-last catch-all ranges (D14), and a `[Host]` block mirroring the
 * overlay's magic DNS (`<name><hostSuffix>`) plus every service whose host
 * has an address on that overlay (`dnsName → easytier_ip`). Service aliases
 * are not restricted to ssh-inventory: a declared service on a mesh-overlay
 * host must still resolve, or Surge falls through to a wildcard resolver
 * and the /32 pin never matches. The output replaces a hand-rolled
 * per-fleet generator; its acceptance was byte-parity with that generator's
 * artifact (D19) — the intents section is the first deliberate content change
 * past it, accepted by semantic parity with the hand rules it replaces.
 *
 * PEER REGISTRIES contribute the `[Host]` names another org DECLARED as
 * services, plus one `DOMAIN` rule per name, and nothing else. A profile
 * that routes another org's mesh space (a `routing` intent over their range)
 * must also RESOLVE their names, or Surge asks a public resolver, gets a
 * public answer, and the range rule never matches — the same failure the
 * local service aliases exist to close, one org over. Resolving is only half
 * of it: every range rule this profile emits carries `no-resolve`, so a
 * request made BY NAME skips all of them and falls to `FINAL` — the peer
 * name resolves to a mesh address and then leaves over the final policy.
 * Each peer name therefore gets a `DOMAIN` rule at the group THIS profile's
 * own rules give that address (pins → intents → catch-alls, Surge's own
 * first-match order); a name whose address no rule of this profile's covers
 * gets none, and falls to `FINAL` on purpose (a peer's public entry point is
 * not this profile's to route). Local service names need no such pass: their
 * routing is declared in this registry as a domain intent.
 *
 * The peer's own routing intent, policies, proxy exits and pins are NOT
 * read: this profile's routing authority stays in its own registry, so a
 * peer publish can add a name but can never silently re-route this profile —
 * a derived rule carries the policy this profile already assigned that
 * address, and a domain intent of this profile's covering the name suppresses
 * the derived line entirely. A peer's HOSTS contribute no magic-DNS line
 * either — `<name><hostSuffix>` describes this overlay's resolver, and a peer
 * host has no entry in it. Peers are also why the two registries stay
 * separate files: copying a peer's hosts into this registry's hand section is
 * `[dup-entity]` at validate time (D4).
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
import { isHostService, type Service } from "../schema/service.ts";
import { cidrContainsIp, ipToUint32 } from "../lib/cidr.ts";

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
    /** Registry policy the `/32` pins route to, unless a region or host
     *  override names another policy. */
    pinPolicy: z.string().min(1),
    /**
     * Region → registry policy for that region's `/32` pins. Pin-group
     * membership is layout data, never inferred from the region name.
     * `{}` is the explicit answer "every pin uses pinPolicy". Keys must
     * be in regionOrder; unknown keys refuse. Values resolve through
     * policyGroups at render time, same as pinPolicy.
     */
    pinPolicyByRegion: z.record(z.string().min(1), z.string().min(1)),
    /**
     * Host name → registry policy for that host's `/32` pin. Beats
     * pinPolicyByRegion. `{}` is the explicit answer "no host overrides".
     * Keys must name a pinned ssh-inventory mesh host — unknown or
     * unmapped names refuse at render time, never silently drop.
     */
    pinPolicyByHost: z.record(z.string().min(1), z.string().min(1)),
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
    for (const region of Object.keys(layout.pinPolicyByRegion)) {
      if (!regions.has(region)) {
        ctx.addIssue({
          code: "custom",
          path: ["pinPolicyByRegion", region],
          message: `pinPolicyByRegion region "${region}" is not in regionOrder`,
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
  serviceNames: number;
  /** `[Host]` lines contributed by peer registries, across all peers. */
  peerNames: number;
  /** `DOMAIN` rules derived for those peer names, across all peers. Lower
   *  than `peerNames` whenever a peer name's address is outside every rule
   *  this profile emits, or an own domain intent already covers the name. */
  peerRules: number;
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

interface ServiceAlias {
  dnsName: string;
  ip: string;
  service: string;
}

/** Service dnsName → owner-subnet mesh IP. Overlay-sourced hosts are
 *  included: the member pin set is ssh-inventory only, but a declared
 *  service must still resolve. Static-answer services are skipped — their
 *  literal answers belong to `public`-scoped views, and a mesh view never
 *  borrows a public value (schema/service.ts). */
function serviceMeshAliases(entities: readonly Entity[], meshName: string): ServiceAlias[] {
  const hosts = new Map<string, Host>();
  for (const entity of entities) {
    if (entity.kind === "host" && !hosts.has(entity.name)) hosts.set(entity.name, entity);
  }
  const byDns = new Map<string, ServiceAlias>();
  const services = entities
    .filter((entity): entity is Service => entity.kind === "service")
    .filter(isHostService)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const service of services) {
    const host = hosts.get(service.host);
    if (host === undefined) {
      fail(`service "${service.name}" references undeclared host "${service.host}"`);
    }
    if (host.mesh !== meshName || host.easytier_ip === undefined) continue;
    const existing = byDns.get(service.dnsName);
    if (existing !== undefined && existing.ip !== host.easytier_ip) {
      fail(
        `services "${existing.service}" and "${service.name}" both claim "${service.dnsName}" ` +
          `at different mesh IPs (${existing.ip} vs ${host.easytier_ip})`,
      );
    }
    if (existing === undefined) {
      byDns.set(service.dnsName, {
        dnsName: service.dnsName,
        ip: host.easytier_ip,
        service: service.name,
      });
    }
  }
  return [...byDns.values()].sort((a, b) => (a.dnsName < b.dnsName ? -1 : 1));
}

/** One `[Host]` line contributed by a peer registry. `origin` names the
 *  entity it came from, so a collision message can point at both sides. */
interface PeerName {
  name: string;
  value: string;
  origin: string;
}

/** Every `[Host]` name one peer registry contributes: its DECLARED service
 *  names, and only those.
 *
 *  Peer HOSTS contribute no magic-DNS line. `<name><hostSuffix>` is a claim
 *  about THIS overlay's own resolver — a peer's hosts have no entry in it,
 *  so synthesizing `<peer-host><hostSuffix>` invents a name that resolves
 *  nowhere else in the world. A `[Host]` block is a local override, so the
 *  invention would work here and only here, which is what makes it a trap
 *  rather than a nicety. A peer's names are the ones it DECLARED as
 *  services.
 *
 *  Static-answer services ARE included, unlike the local mesh aliases: a
 *  peer's literal answer is the only answer this profile can have for that
 *  name (it has no vantage inside the peer's LAN to compute one), and its
 *  `public` scope is the peer's statement about its own views, not a bar on
 *  a foreign profile writing the name down. */
function peerNames(registry: Registry): { mesh: string; names: PeerName[] } {
  const entities = allEntities(registry);
  const mesh = ownerSubnetMesh(entities);
  const names: PeerName[] = [];

  const hosts = new Map<string, Host>();
  for (const entity of entities) {
    if (entity.kind === "host" && !hosts.has(entity.name)) hosts.set(entity.name, entity);
  }

  const services = entities
    .filter((entity): entity is Service => entity.kind === "service")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const service of services) {
    if (isHostService(service)) {
      const host = hosts.get(service.host);
      if (host === undefined) {
        fail(`peer service "${service.name}" references undeclared host "${service.host}"`);
      }
      if (host.mesh !== mesh.name || host.easytier_ip === undefined) continue;
      names.push({
        name: service.dnsName,
        value: host.easytier_ip,
        origin: `service "${service.name}"`,
      });
      continue;
    }
    // Static answer: A → the literal address, CNAME → a Surge [Host] alias
    // (`foo.com = bar.com`), which is the peer's own indirection preserved.
    names.push({
      name: service.dnsName,
      value: service.answer.value,
      origin: `service "${service.name}"`,
    });
  }

  return { mesh: mesh.name, names };
}

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

export function renderSurge(
  registry: Registry,
  layout: SurgeLayout,
  peers: readonly Registry[] = [],
): SurgeRender {
  const entities = allEntities(registry);
  const mesh = ownerSubnetMesh(entities);

  const members = entities.filter(
    (entity): entity is Member =>
      entity.kind === "host" &&
      entity.source === HOST_SOURCE.sshInventory &&
      entity.mesh === mesh.name &&
      entity.easytier_ip !== undefined,
  );
  const aliases = serviceMeshAliases(entities, mesh.name);
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
  // pinPolicy must resolve even when every region/host overrides it — a
  // layout that names a missing default is still incomplete.
  const defaultPinGroup = group(layout.pinPolicy, "pinPolicy");
  const pinGroupForRegion = (region: string): string => {
    const override = layout.pinPolicyByRegion[region];
    if (override === undefined) return defaultPinGroup;
    return group(override, `pinPolicyByRegion "${region}"`);
  };
  const pinGroupFor = (member: Member): string => {
    const byHost = layout.pinPolicyByHost[member.name];
    if (byHost !== undefined) return group(byHost, `pinPolicyByHost "${member.name}"`);
    return member.region !== undefined ? pinGroupForRegion(member.region) : defaultPinGroup;
  };

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
  const pinnedByName = new Map(pins.map((pin) => [pin.name, pin]));
  const memberByName = new Map(members.map((member) => [member.name, member]));
  for (const name of Object.keys(layout.pinPolicyByHost).sort()) {
    if (!memberByName.has(name)) {
      fail(
        `pinPolicyByHost "${name}" names no ssh-inventory mesh host — ` +
          `a typo would silently leave the pin on the region/default group`,
      );
    }
    if (!pinnedByName.has(name)) {
      fail(
        `pinPolicyByHost "${name}" is not a pinned host (region unset or unlisted) — ` +
          `the override would never emit`,
      );
    }
  }

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

  // ── [Host] answers, resolved BEFORE the rules are emitted: member
  // magic-DNS, then local service aliases, then each peer's declared names.
  // Order is precedence — a local name always wins the line, and a peer that
  // would change one is a hard failure. Silent precedence would let a peer's
  // publish move this profile's traffic without a diff anyone reads. The set
  // is built here rather than while emitting `[Host]` because the peer names
  // also need a `DOMAIN` rule, and a rule cannot be written after the section
  // it belongs to.
  interface HostLine {
    name: string;
    value: string;
  }
  const hostAnswers = new Map<string, string>();
  const memberLines: HostLine[] = [];
  for (const member of [...members].sort(byIp)) {
    const name = `${member.name}${layout.hostSuffix}`;
    hostAnswers.set(name, member.easytier_ip);
    memberLines.push({ name, value: member.easytier_ip });
  }
  const aliasLines: HostLine[] = [];
  for (const alias of aliases) {
    const existing = hostAnswers.get(alias.dnsName);
    if (existing !== undefined && existing !== alias.ip) {
      fail(
        `service "${alias.service}" dnsName "${alias.dnsName}" collides with a member [Host] at ${existing}`,
      );
    }
    if (existing !== undefined) continue;
    hostAnswers.set(alias.dnsName, alias.ip);
    aliasLines.push({ name: alias.dnsName, value: alias.ip });
  }
  interface PeerBlock {
    mesh: string;
    lines: HostLine[];
  }
  const peerBlocks: PeerBlock[] = [];
  for (const peer of peers) {
    const { mesh: peerMesh, names } = peerNames(peer);
    const emitted: HostLine[] = [];
    for (const entry of names) {
      const existing = hostAnswers.get(entry.name);
      if (existing !== undefined && existing !== entry.value) {
        fail(
          `peer mesh "${peerMesh}" ${entry.origin} maps "${entry.name}" to ${entry.value}, ` +
            `but this profile already maps it to ${existing} — ` +
            `one name cannot carry two answers in [Host]`,
        );
      }
      if (existing !== undefined) continue;
      hostAnswers.set(entry.name, entry.value);
      emitted.push({ name: entry.name, value: entry.value });
    }
    if (emitted.length > 0) peerBlocks.push({ mesh: peerMesh, lines: emitted });
  }
  const peerCount = peerBlocks.reduce((total, block) => total + block.lines.length, 0);

  // ── peer name rules: the routing half of a peer name. `groupForAddress`
  // replays THIS profile's own rules in Surge's first-match order over an
  // address — the answer a `[Host]` line hands back — and returns the group
  // that would win. `undefined` means no rule of this profile's covers the
  // address, so the name gets no rule and falls to FINAL, which is the
  // correct answer for a peer's public entry point.
  const groupForAddress = (ip: string): string | undefined => {
    for (const pin of pins) {
      if (pin.easytier_ip === ip) return pinGroupFor(pin);
    }
    for (const entry of intents) {
      if (entry.match.match === "cidr" && cidrContainsIp(entry.match.cidr, ip)) {
        return intentGroup(entry);
      }
    }
    for (const entry of catchAlls) {
      if (cidrContainsIp(entry.match.cidr, ip)) {
        return group(entry.policy, `catch-all "${entry.name}"`);
      }
    }
    return undefined;
  };
  // A `[Host]` value is an address (route it) or another name (a CNAME the
  // peer kept — this profile has no address to reason from, so no rule).
  const isIpv4 = (value: string): boolean => {
    try {
      ipToUint32(value);
      return true;
    } catch {
      return false;
    }
  };
  // An own domain intent already decides the name, and sits above the derived
  // block: emitting a second line would be a rule that never fires.
  const domainIntentCovers = (name: string): boolean =>
    intents.some((entry) => {
      switch (entry.match.match) {
        case "domain":
          return entry.match.domain === name;
        case "domain-suffix":
          return name === entry.match.suffix || name.endsWith(`.${entry.match.suffix}`);
        case "cidr":
          return false;
      }
    });
  interface PeerRuleBlock {
    mesh: string;
    rules: string[];
    /** Names left to FINAL, documented so the gap is visible, not inferred. */
    unrouted: HostLine[];
  }
  const peerRuleBlocks: PeerRuleBlock[] = [];
  for (const block of peerBlocks) {
    const rules: string[] = [];
    const unrouted: HostLine[] = [];
    for (const line of block.lines) {
      if (domainIntentCovers(line.name)) continue;
      const groupName = isIpv4(line.value) ? groupForAddress(line.value) : undefined;
      if (groupName === undefined) {
        unrouted.push(line);
        continue;
      }
      rules.push(`DOMAIN,${line.name},${groupName}`);
    }
    if (rules.length > 0 || unrouted.length > 0) {
      peerRuleBlocks.push({ mesh: block.mesh, rules, unrouted });
    }
  }
  const peerRuleCount = peerRuleBlocks.reduce((total, block) => total + block.rules.length, 0);

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
    `# Per-host /32 pins grouped by region (restore documentation); default pin policy ${defaultPinGroup}`,
  );
  lines.push("");

  for (const region of layout.regionOrder) {
    const regionPins = pins.filter((pin) => pin.region === region);
    if (regionPins.length === 0) continue;
    const regionPinGroup = pinGroupForRegion(region);
    lines.push(
      `# ${region.toUpperCase()} (jumper on restore: ${layout.jumpers[region]!}; pins via ${regionPinGroup})`,
    );
    for (const pin of regionPins) {
      lines.push(`IP-CIDR,${pin.easytier_ip}/32,${pinGroupFor(pin)},no-resolve // ${pin.name}`);
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

  for (const block of peerRuleBlocks) {
    lines.push(
      `# Peer mesh: ${block.mesh} — one rule per resolved name, at the policy this`,
      "# profile's own rules give that address. Every range rule carries no-resolve,",
      "# so a request made by NAME reaches none of them without these lines.",
    );
    lines.push(...block.rules);
    if (block.unrouted.length > 0) {
      lines.push("# No rule of this profile's covers these names' addresses → FINAL:");
      for (const line of block.unrouted) {
        lines.push(`#   ${line.name}  ${line.value}`);
      }
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
  for (const line of memberLines) {
    lines.push(`${line.name} = ${line.value}`);
  }
  if (aliasLines.length > 0) {
    lines.push("# Service DNS names → owner-subnet mesh IP");
    for (const line of aliasLines) {
      lines.push(`${line.name} = ${line.value}`);
    }
  }
  for (const block of peerBlocks) {
    lines.push(
      `# Peer mesh: ${block.mesh} — declared service names, routed by the peer rules above`,
    );
    for (const line of block.lines) {
      lines.push(`${line.name} = ${line.value}`);
    }
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
      serviceNames: aliases.length,
      peerNames: peerCount,
      peerRules: peerRuleCount,
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
