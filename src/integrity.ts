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
  cidrContainsCidr,
  cidrContainsIp,
  cidrsOverlap,
  hasHostBits,
} from "./lib/cidr.ts";
import type { Entity, Registry } from "./schema/registry.ts";
import { RegistrySchema } from "./schema/registry.ts";
import { isHostService } from "./schema/service.ts";
import { answerIn } from "./schema/view.ts";

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

/** service.host → a declared host entity (static-answer services have none). */
function checkServiceHostRefs(all: Located[], groups: Map<string, Located[]>, report: Reporter): void {
  for (const located of all) {
    if (located.entity.kind !== "service" || !isHostService(located.entity)) continue;
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

/**
 * A routing intent's declared `mesh`, checked against what THIS envelope can
 * see. The name may resolve in another org's file (org files render
 * individually), so a dangling name is NOT an error here — but a mesh entity
 * that IS present must contain the intent's cidr range: declaring range X
 * inside mesh M when M's space does not hold X is a typo whichever file it
 * parses in. Domain-shaped intents carry no range to check.
 */
function checkRoutingMeshRanges(
  all: Located[],
  groups: Map<string, Located[]>,
  report: Reporter,
): void {
  for (const located of all) {
    if (located.entity.kind !== "routing" || located.entity.entry !== "intent") continue;
    const intent = located.entity;
    if (intent.mesh === undefined || intent.match.match !== "cidr") continue;
    const mesh = groups.get(`mesh\u0000${intent.mesh}`)?.[0]?.entity;
    if (mesh === undefined || mesh.kind !== "mesh" || mesh.cidr === undefined) continue;
    if (!cidrContainsCidr(mesh.cidr, intent.match.cidr)) {
      report(
        [...located.path, "mesh"],
        `[routing-mesh] ${ident(located)}: match.cidr ${intent.match.cidr} is outside mesh "${intent.mesh}" cidr ${mesh.cidr} — a member target would route the wrong range over its mesh path`,
      );
    }
  }
}

/**
 * routeTarget references. `resolver` and every `policyOutbounds` key resolve
 * intra-org (a target, its resolver and its policies travel together), so
 * both are hard dangling checks. `memberOf` keys name mesh entities that may
 * live in ANOTHER org's file — same cross-org tolerance as routing.mesh; the
 * routerules renderer refuses a membership no intent declares, which is where
 * a memberOf typo surfaces loudly.
 */
function checkRouteTargetRefs(
  all: Located[],
  groups: Map<string, Located[]>,
  report: Reporter,
): void {
  for (const located of all) {
    if (located.entity.kind !== "routeTarget") continue;
    const target = located.entity;
    if (!groups.has(`resolver\u0000${target.resolver}`)) {
      report(
        [...located.path, "resolver"],
        `[routetarget-refs] ${ident(located)}: resolver "${target.resolver}" is not a declared resolver entity`,
      );
    }
    for (const policyName of Object.keys(target.policyOutbounds)) {
      if (!groups.has(`policy\u0000${policyName}`)) {
        report(
          [...located.path, "policyOutbounds", policyName],
          `[routetarget-refs] ${ident(located)}: policyOutbounds key "${policyName}" is not a declared policy entity`,
        );
      }
    }
  }
}

/** resolver.views → declared view entities, no duplicates in the list. */
function checkResolverViews(all: Located[], groups: Map<string, Located[]>, report: Reporter): void {
  for (const located of all) {
    if (located.entity.kind !== "resolver") continue;
    const seen = new Set<string>();
    located.entity.views.forEach((viewName, i) => {
      if (seen.has(viewName)) {
        report(
          [...located.path, "views", i],
          `[resolver-views] ${ident(located)}: view "${viewName}" is listed twice — precedence is the list order, a repeat is a contradiction`,
        );
      }
      seen.add(viewName);
      if (!groups.has(`view\u0000${viewName}`)) {
        report(
          [...located.path, "views", i],
          `[resolver-views] ${ident(located)}: view "${viewName}" is not a declared view entity`,
        );
      }
    });
  }
}

/**
 * The set of views that answer for a service, computed the one lawful way
 * (`answerIn`): a host-backed name answers where its host has an address, a
 * static name answers in every `public` view. Undefined when a host
 * reference does not resolve — `[host-ref]` already reports that; these
 * checks stay silent to avoid a second issue for the same root cause.
 */
function answerableViews(
  entity: Entity & { kind: "service" },
  all: Located[],
  groups: Map<string, Located[]>,
): Set<string> | undefined {
  let host: Entity | undefined;
  if (isHostService(entity)) {
    host = groups.get(`host\u0000${entity.host}`)?.[0]?.entity;
    if (host === undefined || host.kind !== "host") return undefined;
  }
  const views = new Set<string>();
  for (const located of all) {
    if (located.entity.kind !== "view") continue;
    if (answerIn(located.entity, entity, host as Extract<Entity, { kind: "host" }> | undefined) !== undefined) {
      views.add(located.entity.name);
    }
  }
  return views;
}

/** "host \"x\"" or "static answer" — what a service's answers come from. */
function answerSource(service: Entity & { kind: "service" }): string {
  return isHostService(service) ? `host "${service.host}"` : "its static answer";
}

/**
 * A `service.views` declaration is EXACT: the declared set must equal the
 * computed answerable set. A declared view that no longer answers is the
 * drop-out guard — the whole point is that a name losing its primary answer
 * refuses fleet-wide instead of silently promoting another view's answer at
 * a gateway. An answering view left undeclared is the same drift in the
 * other direction.
 */
function checkServiceViewDeclarations(
  all: Located[],
  groups: Map<string, Located[]>,
  report: Reporter,
): void {
  for (const located of all) {
    if (located.entity.kind !== "service" || located.entity.views === undefined) continue;
    const service = located.entity;
    const answerable = answerableViews(service, all, groups);
    if (answerable === undefined) continue; // dangling host — [host-ref] owns it

    service.views!.forEach((viewName, i) => {
      if (!groups.has(`view\u0000${viewName}`)) {
        report(
          [...located.path, "views", i],
          `[service-views] ${ident(located)}: declared view "${viewName}" is not a declared view entity`,
        );
      } else if (!answerable.has(viewName)) {
        report(
          [...located.path, "views", i],
          `[service-views] ${ident(located)}: declared view "${viewName}" has no answer for ${answerSource(service)} — the name would silently drop out of that vantage (or promote another view's answer at a merged gateway); fix the ${isHostService(service) ? "host's address data" : "view's scope"} or the declaration`,
        );
      }
    });

    const declared = new Set(service.views);
    for (const viewName of [...answerable].sort()) {
      if (!declared.has(viewName)) {
        report(
          [...located.path, "views"],
          `[service-views] ${ident(located)}: view "${viewName}" answers for ${answerSource(service)} but is not declared — declarations are exact; add it or remove the ${isHostService(service) ? "host's address on that vantage" : "public view"}`,
        );
      }
    }
  }
}

/**
 * A name answering in two or more views of ONE resolver is a precedence
 * decision. Undeclared, that decision would be made silently by list order;
 * with a declaration, both future drift directions are `[service-views]`
 * refusals. So the ambiguity itself demands the declaration.
 */
function checkResolverAmbiguity(
  all: Located[],
  groups: Map<string, Located[]>,
  report: Reporter,
): void {
  const resolvers = all.filter(
    (located): located is Located & { entity: Entity & { kind: "resolver" } } =>
      located.entity.kind === "resolver",
  );
  if (resolvers.length === 0) return;

  for (const located of all) {
    if (located.entity.kind !== "service" || located.entity.views !== undefined) continue;
    const answerable = answerableViews(located.entity, all, groups);
    if (answerable === undefined) continue;
    for (const resolver of resolvers) {
      const overlapping = resolver.entity.views.filter((viewName) => answerable.has(viewName));
      if (overlapping.length >= 2) {
        report(
          [...located.path],
          `[resolver-ambiguous] ${ident(located)}: answers in ${overlapping.length} views of resolver "${resolver.entity.name}" (${overlapping.join(", ")}) but declares none — add service.views so the precedence pick is declared intent, not accident`,
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
    // Both routing variants: intent matches may be cidr-shaped; catch-all
    // matches always are. A catch-all naming retired space must fail like
    // any other cidr field — the entry type must not exempt it from the walk.
    if (entity.kind === "routing" && entity.match.match === "cidr") {
      visit(located, [...located.path, "match", "cidr"], entity.match.cidr, "match.cidr");
    }
  }
}

/** Every IPv4-valued field, with its absolute path. `proxyExit.host` joins
 * only when it is IPv4-shaped (it may be a hostname); a static A answer
 * joins as `answer.value`. */
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
    if (entity.kind === "service" && !isHostService(entity) && entity.answer.type === "A") {
      visit(located, [...located.path, "answer", "value"], entity.answer.value, "answer.value");
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
  checkRoutingMeshRanges(all, groups, report);
  checkRouteTargetRefs(all, groups, report);
  checkHostMembershipRefs(all, groups, report);
  checkResolverViews(all, groups, report);
  checkServiceViewDeclarations(all, groups, report);
  checkResolverAmbiguity(all, groups, report);
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
