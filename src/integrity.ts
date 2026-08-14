/**
 * Registry integrity: every cross-entity check the schemas (Unit 1) cannot
 * express field-locally. Attached as ONE top-level `superRefine` on
 * `RegistrySchema` (D15) so a single parse collects EVERY violation — never
 * fail-fast on the first.
 *
 * Every issue message is `[check-tag] <stable identifier>: <what>` — the
 * identifier is the entity's kind + name + section (dnsName for services),
 * because array indices shift on hand edits and a JSON path alone is a bad
 * error message. The path is still attached, absolute from the registry root
 * (zod v4 removed `ctx.path`; a top-level refine makes root-relative ==
 * absolute, which is why the refine must stay top-level).
 */

import { z } from "zod";
import {
  canonicalCidr,
  cidrContainsIp,
  cidrsOverlap,
  hasHostBits,
} from "./lib/cidr.ts";
import type { Entity, Registry } from "./schema/registry.ts";
import { RegistrySchema } from "./schema/registry.ts";

/**
 * Ranges retired from a fleet: appearing anywhere as live data is a hard
 * failure.
 *
 * PLACEHOLDER VALUES. This repo is public and org-agnostic, so it carries
 * fixture-space ranges only — a real retired range named here would publish
 * the very inventory detail the registry keeps private. An operator enforcing
 * a real fleet supplies the real ranges through the envelope's optional
 * `retiredRanges` field (private registry data); validation enforces the
 * union of that field and this constant.
 *
 * Two classes deliberately stay OUT of any such list, whatever the values:
 * - A range whose retirement is unconfirmed. It must never hard-fail, because
 *   a false positive blocks live data that is still legitimately in use.
 * - An inventory label for physical boxes that is never routable. That is not
 *   retired address space; it simply must not be declared as an allocation,
 *   and it is representable only as a non-routable annotation (e.g. entity
 *   `description`), which no check inspects.
 */
export const RETIRED_RANGES = ["10.98.144.0/24", "10.98.192.0/20"] as const;

type Path = (string | number)[];

/** An entity plus where it lives: section label + absolute path. */
interface Located {
  entity: Entity;
  /** `snapshots.<org>` or `hand` — the D4 "source" named in messages. */
  section: string;
  path: Path;
  fromHand: boolean;
}

/** Stable identifier used in every message about this entity. */
function ident(located: Located): string {
  const entity = located.entity;
  const dns = entity.kind === "service" ? ` dnsName ${entity.dnsName},` : "";
  return `${entity.kind} "${entity.name}" (${dns} in ${located.section})`;
}

function locate(registry: Registry): Located[] {
  const all: Located[] = [];
  for (const [org, entities] of Object.entries(registry.snapshots)) {
    entities.forEach((entity, i) =>
      all.push({ entity, section: `snapshots.${org}`, path: ["snapshots", org, i], fromHand: false }),
    );
  }
  registry.hand.forEach((entity, i) =>
    all.push({ entity, section: "hand", path: ["hand", i], fromHand: true }),
  );
  return all;
}

/** kind+name → occurrences, insertion order. References resolve to the first. */
function byKindName(all: Located[]): Map<string, Located[]> {
  const map = new Map<string, Located[]>();
  for (const located of all) {
    const key = `${located.entity.kind}\u0000${located.entity.name}`;
    const group = map.get(key);
    if (group) group.push(located);
    else map.set(key, [located]);
  }
  return map;
}

interface Reporter {
  (path: Path, message: string): void;
}

/** D4: the same entity in a snapshot AND the hand section; plus same-kind
 * same-name duplicates anywhere (two snapshots, or twice in one section) —
 * duplicated names make every by-name reference ambiguous. */
function checkDuplicateEntities(groups: Map<string, Located[]>, report: Reporter): void {
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const snapshot = group.filter((g) => !g.fromHand);
    const hand = group.filter((g) => g.fromHand);
    if (snapshot.length > 0 && hand.length > 0) {
      // Anchor on the hand occurrence: D4's fix is "delete the hand entry".
      for (const dup of hand) {
        report(
          dup.path,
          `[dup-entity] ${ident(dup)}: also exported by ${snapshot
            .map((s) => s.section)
            .join(", ")} — the same entity may not live in a snapshot and the hand section (D4); delete the hand entry`,
        );
      }
      continue;
    }
    for (const dup of group.slice(1)) {
      report(
        dup.path,
        `[dup-entity] ${ident(dup)}: duplicate of the entry in ${group[0]!.section} — names are per-kind unique so by-name references stay unambiguous`,
      );
    }
  }
}

/** service.host → a declared host entity. */
function checkServiceHostRefs(all: Located[], groups: Map<string, Located[]>, report: Reporter): void {
  for (const located of all) {
    if (located.entity.kind !== "service") continue;
    if (!groups.has(`host\u0000${located.entity.host}`)) {
      report(
        [...located.path, "host"],
        `[host-ref] ${ident(located)}: host "${located.entity.host}" is not a declared host entity`,
      );
    }
  }
}

/** routing.policy → a declared policy entity. */
function checkPolicyRefs(all: Located[], groups: Map<string, Located[]>, report: Reporter): void {
  for (const located of all) {
    if (located.entity.kind !== "routing") continue;
    if (!groups.has(`policy\u0000${located.entity.policy}`)) {
      report(
        [...located.path, "policy"],
        `[policy-ref] ${ident(located)}: policy "${located.entity.policy}" is not a declared policy entity`,
      );
    }
  }
}

/** host.mesh and host.networks keys → declared mesh/network entities. */
function checkHostMembershipRefs(
  all: Located[],
  groups: Map<string, Located[]>,
  report: Reporter,
): void {
  for (const located of all) {
    if (located.entity.kind !== "host") continue;
    const host = located.entity;
    if (host.mesh !== undefined && !groups.has(`mesh\u0000${host.mesh}`)) {
      report(
        [...located.path, "mesh"],
        `[mesh-ref] ${ident(located)}: mesh "${host.mesh}" is not a declared mesh entity`,
      );
    }
    for (const networkName of Object.keys(host.networks ?? {})) {
      if (!groups.has(`network\u0000${networkName}`)) {
        report(
          [...located.path, "networks", networkName],
          `[network-ref] ${ident(located)}: network "${networkName}" is not a declared network entity`,
        );
      }
    }
  }
}

/** service.dnsName unique across the whole registry. */
function checkDnsNamesUnique(all: Located[], report: Reporter): void {
  const byDns = new Map<string, Located[]>();
  for (const located of all) {
    if (located.entity.kind !== "service") continue;
    const group = byDns.get(located.entity.dnsName);
    if (group) group.push(located);
    else byDns.set(located.entity.dnsName, [located]);
  }
  for (const [dnsName, group] of byDns) {
    if (group.length < 2) continue;
    const holders = group.map((g) => `service "${g.entity.name}" (${g.section})`).join(", ");
    for (const dup of group.slice(1)) {
      report(
        [...dup.path, "dnsName"],
        `[dns-unique] ${ident(dup)}: dnsName "${dnsName}" is also claimed by ${holders
          .split(", ")
          .filter((h) => !h.startsWith(`service "${dup.entity.name}"`))
          .join(", ")}`,
      );
    }
  }
}

/**
 * Every host address sits inside the CIDR it claims membership of:
 * `easytier_ip` ∈ its mesh's cidr, `networks[N].ip` ∈ network N's cidr.
 * Unresolvable or cidr-less targets are skipped here — dangling refs are
 * their own check, and a mesh without a declared cidr constrains nothing.
 */
function checkIpsInsideCidrs(all: Located[], groups: Map<string, Located[]>, report: Reporter): void {
  const firstOf = (kind: string, name: string): Entity | undefined =>
    groups.get(`${kind}\u0000${name}`)?.[0]?.entity;

  for (const located of all) {
    if (located.entity.kind !== "host") continue;
    const host = located.entity;

    if (host.mesh !== undefined && host.easytier_ip !== undefined) {
      const mesh = firstOf("mesh", host.mesh);
      if (mesh?.kind === "mesh" && mesh.cidr !== undefined && !cidrContainsIp(mesh.cidr, host.easytier_ip)) {
        report(
          [...located.path, "easytier_ip"],
          `[ip-in-cidr] ${ident(located)}: easytier_ip ${host.easytier_ip} is outside mesh "${mesh.name}" cidr ${mesh.cidr}`,
        );
      }
    }

    for (const [networkName, membership] of Object.entries(host.networks ?? {})) {
      const network = firstOf("network", networkName);
      if (network?.kind === "network" && !cidrContainsIp(network.cidr, membership.ip)) {
        report(
          [...located.path, "networks", networkName, "ip"],
          `[ip-in-cidr] ${ident(located)}: ip ${membership.ip} is outside network "${networkName}" cidr ${network.cidr}`,
        );
      }
    }
  }
}

/**
 * Address allocations (network.cidr, mesh.cidr) must be pairwise disjoint —
 * "no silent CIDR overlap". Containment counts: CIDRs are laminar, so any
 * overlap IS containment, and a plan-level supernet belongs in a routing
 * match (where D14's priority governs nesting), not in an allocation entity.
 * One issue per pair, anchored on the later entity.
 */
function checkAllocationsDisjoint(all: Located[], report: Reporter): void {
  const allocations = all.filter(
    (located): located is Located & { entity: Entity & { cidr: string } } =>
      (located.entity.kind === "network" || located.entity.kind === "mesh") &&
      "cidr" in located.entity &&
      located.entity.cidr !== undefined,
  );
  for (let j = 1; j < allocations.length; j++) {
    for (let i = 0; i < j; i++) {
      const a = allocations[i]!;
      const b = allocations[j]!;
      if (cidrsOverlap(a.entity.cidr, b.entity.cidr)) {
        report(
          [...b.path, "cidr"],
          `[cidr-overlap] ${ident(b)}: cidr ${b.entity.cidr} overlaps ${a.entity.kind} "${a.entity.name}" (${a.section}) cidr ${a.entity.cidr} — allocations must be disjoint; a covering supernet belongs in a routing match, not an allocation entity`,
        );
      }
    }
  }
}

/** Every cidr-valued field, with its absolute path — one walk shared by the
 * canonical-base and retired-range checks. */
function eachCidrField(
  all: Located[],
  visit: (located: Located, path: Path, cidr: string, field: string) => void,
): void {
  for (const located of all) {
    const entity = located.entity;
    if ((entity.kind === "network" || entity.kind === "mesh") && entity.cidr !== undefined) {
      visit(located, [...located.path, "cidr"], entity.cidr, "cidr");
    }
    if (
      (entity.kind === "network" || entity.kind === "mesh") &&
      entity.allocation?.vocabulary === "owner-subnet"
    ) {
      visit(located, [...located.path, "allocation", "subnet"], entity.allocation.subnet, "allocation.subnet");
    }
    if (entity.kind === "routing" && entity.entry === "intent" && entity.match.match === "cidr") {
      visit(located, [...located.path, "match", "cidr"], entity.match.cidr, "match.cidr");
    }
  }
}

/** Every IPv4-valued field, with its absolute path. `proxyExit.host` joins
 * only when it is IPv4-shaped (it may be a hostname). */
function eachIpField(
  all: Located[],
  visit: (located: Located, path: Path, ip: string, field: string) => void,
): void {
  const ipShaped = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  for (const located of all) {
    const entity = located.entity;
    if (entity.kind === "host") {
      if (entity.easytier_ip !== undefined) {
        visit(located, [...located.path, "easytier_ip"], entity.easytier_ip, "easytier_ip");
      }
      for (const [networkName, membership] of Object.entries(entity.networks ?? {})) {
        visit(located, [...located.path, "networks", networkName, "ip"], membership.ip, `networks.${networkName}.ip`);
      }
    }
    if (entity.kind === "proxyExit" && ipShaped.test(entity.host)) {
      visit(located, [...located.path, "host"], entity.host, "host");
    }
  }
}

/** A CIDR written with host bits set is a violation, not a silent masking —
 * spike evidence: `z.cidrv4()` and both candidate libraries accept it. */
function checkCidrsCanonical(all: Located[], report: Reporter): void {
  eachCidrField(all, (located, path, cidr, field) => {
    if (hasHostBits(cidr)) {
      report(
        path,
        `[cidr-canonical] ${ident(located)}: ${field} ${cidr} has host bits set — write the network address ${canonicalCidr(cidr)} or fix the prefix`,
      );
    }
  });
}

/** Retired ranges hard-fail wherever they appear as live data: any cidr
 * overlapping one, any address inside one. Enforces the union of the
 * built-in placeholders and the envelope's data-driven `retiredRanges`. */
function checkRetiredRanges(all: Located[], report: Reporter, dataRanges: readonly string[]): void {
  const ranges = [...new Set([...RETIRED_RANGES, ...dataRanges])];
  eachCidrField(all, (located, path, cidr, field) => {
    for (const retired of ranges) {
      if (cidrsOverlap(cidr, retired)) {
        report(
          path,
          `[retired-range] ${ident(located)}: ${field} ${cidr} overlaps retired range ${retired} — retired space must not appear as live data`,
        );
      }
    }
  });
  eachIpField(all, (located, path, ip, field) => {
    for (const retired of ranges) {
      if (cidrContainsIp(retired, ip)) {
        report(
          path,
          `[retired-range] ${ident(located)}: ${field} ${ip} is inside retired range ${retired} — retired space must not appear as live data`,
        );
      }
    }
  });
}

/** The one integrity entry point; runs every check, collects every issue. */
export function checkIntegrity(registry: Registry, ctx: z.RefinementCtx): void {
  const report: Reporter = (path, message) => {
    ctx.addIssue({ code: "custom", path, message });
  };
  const all = locate(registry);
  const groups = byKindName(all);

  checkDuplicateEntities(groups, report);
  checkServiceHostRefs(all, groups, report);
  checkPolicyRefs(all, groups, report);
  checkHostMembershipRefs(all, groups, report);
  checkDnsNamesUnique(all, report);
  checkIpsInsideCidrs(all, groups, report);
  checkAllocationsDisjoint(all, report);
  checkCidrsCanonical(all, report);
  checkRetiredRanges(all, report, registry.retiredRanges ?? []);
}

/**
 * `RegistrySchema` + integrity. Shape errors surface first (zod runs the
 * refine only once the envelope parses); integrity violations then arrive
 * all at once.
 */
export const RegistryWithIntegritySchema = RegistrySchema.superRefine(checkIntegrity);
