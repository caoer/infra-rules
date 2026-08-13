/**
 * sing-box `dnsRules` renderer (Unit 6).
 *
 * Emits one file per view — `singbox/dnsrules-<view>.json`, body
 * `{ dnsRules: [...] }` — for the existing gateway contract option
 * `osf….dnsRules` ("Extra DNS rules inserted before the tun-in catch-all",
 * the gateway contract option). Ordering against the
 * catch-all is owned by that contract; this renderer owns only the order
 * inside its own list.
 *
 * Derivation (v1): service entities only. Each service whose host has an
 * answer in the view (view.ts `answerFor`) becomes one exact-domain
 * `predefined` rule targeting sing-box 1.14.0-alpha.35 — the shape both
 * consuming gateways already use. No answer for the view → the name is
 * omitted from that view's file, never borrowed from another view. A view
 * with no answers renders `{ dnsRules: [] }` — a valid empty list, not null.
 *
 * First-match ordering: exact `domain` rules sort before `domain_suffix`
 * rules — a suffix rule ahead of an exact name under it would swallow the
 * exact answer. v1 emits exact rules only, but every rule passes through
 * `sortDnsRules`, so future suffix emission inherits the invariant.
 *
 * D12 file order: cos views (`org-site-band` allocation) first, owner-mesh views
 * (`owner-subnet`) last — greenfield gateways ahead of the live 44-entry
 * surface. The rank is read from the scope entity's allocation vocabulary,
 * never from hardcoded names; views whose scope entity is missing or carries
 * no allocation rank between the two.
 */

import type { Registry, Entity } from "../schema/registry.ts";
import { answerFor, type View } from "../schema/view.ts";
import type { JsonObject } from "../lib/canonical.ts";
import { registerRenderer, type RenderedFile } from "./index.ts";

/** The one rule shape v1 derives: exact names, predefined RR answers. */
export type ExactDnsRule = {
  domain: string[];
  action: "predefined";
  answer: string[];
};

/**
 * Exact rules before suffix rules (first-match safety), each group sorted by
 * its first pattern so output is canonical. Accepts any contract rule shape
 * (the option is `attrsOf anything`); a rule is "exact" iff it has a `domain`
 * matcher.
 */
export function sortDnsRules<T extends JsonObject>(rules: readonly T[]): T[] {
  const firstPattern = (rule: T): string => {
    for (const key of ["domain", "domain_suffix"] as const) {
      const patterns = rule[key];
      if (Array.isArray(patterns) && typeof patterns[0] === "string") return patterns[0];
    }
    return "";
  };
  const byPattern = (a: T, b: T): number => {
    const [ka, kb] = [firstPattern(a), firstPattern(b)];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  const exact = rules.filter((rule) => rule["domain"] !== undefined);
  const suffix = rules.filter((rule) => rule["domain"] === undefined);
  return [...exact.sort(byPattern), ...suffix.sort(byPattern)];
}

/** D12 rank: cos vocabulary → 0, unallocated/unknown → 1, owner-mesh vocabulary → 2. */
function viewRank(view: View, entities: readonly Entity[]): number {
  const scope = view.scope;
  const scopeEntity = entities.find((entity) =>
    scope.kind === "mesh"
      ? entity.kind === "mesh" && entity.name === scope.mesh
      : entity.kind === "network" && entity.name === scope.network,
  );
  if (scopeEntity === undefined) return 1;
  if (scopeEntity.kind !== "mesh" && scopeEntity.kind !== "network") return 1;
  switch (scopeEntity.allocation?.vocabulary) {
    case "org-site-band":
      return 0;
    case "owner-subnet":
      return 2;
    default:
      return 1;
  }
}

function render(registry: Registry): RenderedFile[] {
  const entities = [...Object.values(registry.snapshots).flat(), ...registry.hand];
  const views = entities.filter((entity) => entity.kind === "view");
  const services = entities.filter((entity) => entity.kind === "service");
  const hosts = new Map(
    entities.filter((entity) => entity.kind === "host").map((host) => [host.name, host]),
  );

  const ordered = views
    .map((view) => ({ view, rank: viewRank(view, entities) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.view.name < b.view.name ? -1 : a.view.name > b.view.name ? 1 : 0;
    });

  return ordered.map(({ view }) => {
    const rules: ExactDnsRule[] = [];
    for (const service of services) {
      const host = hosts.get(service.host);
      if (host === undefined) {
        // Silently skipping would render the name out of a gateway's table;
        // integrity (`validate`) owns the diagnosis, the render must not lie.
        throw new Error(
          `singbox: service "${service.name}" references missing host "${service.host}" — run validate`,
        );
      }
      const answer = answerFor(view, host);
      if (answer === undefined) continue;
      rules.push({
        domain: [service.dnsName],
        action: "predefined",
        answer: [`${service.dnsName}. IN A ${answer}`],
      });
    }
    return {
      path: `singbox/dnsrules-${view.name}.json`,
      value: { dnsRules: sortDnsRules(rules) },
    };
  });
}

export const singboxRenderer = { name: "singbox", render };

registerRenderer(singboxRenderer);
