/**
 * sing-box `dnsRules` renderer (Unit 6).
 *
 * Emits one file per view — `singbox/dnsrules-<view>.json`, body
 * `{ dnsRules: [...] }` — for the existing gateway contract option
 * ("Extra DNS rules inserted before the tun-in catch-all"). Ordering against
 * the catch-all is owned by that contract; this renderer owns only the order
 * inside its own list.
 *
 * Derivation (v1): service entities only. Each service with an answer in
 * the view (view.ts `answerIn` — a host-backed name's computed address as
 * `IN A`, a static answer as `IN A` / `IN CNAME` in its `public` view)
 * becomes one exact-domain `predefined` rule targeting sing-box
 * 1.14.0-alpha.35 — the shape both consuming gateways already use. No answer
 * for the view → the name is omitted from that view's file, never borrowed
 * from another view. A view with no answers renders `{ dnsRules: [] }` — a
 * valid empty list, not null.
 *
 * First-match ordering: exact `domain` rules sort before `domain_suffix`
 * rules — a suffix rule ahead of an exact name under it would swallow the
 * exact answer. v1 emits exact rules only, but every rule passes through
 * `sortDnsRules`, so future suffix emission inherits the invariant.
 *
 * D12 file order: `org-site-band` views first, `owner-subnet` views last —
 * greenfield gateways ahead of the established surface.
 * The rank is read from the scope entity's allocation vocabulary,
 * never from hardcoded names; views whose scope entity is missing or carries
 * no allocation rank between the two.
 *
 * Merged files (`dnsrules-merged-<resolver>.json`): one per resolver entity,
 * emitted after the per-view files, resolver-name-sorted. A resolver names an
 * ORDERED view list; each service answers from the first listed view that has
 * an answer, so precedence is computed here — where the omit semantics live —
 * never by consumer-side file concatenation (which silently promotes the next
 * file's answer when a name drops out of the first, and breaks the
 * exact-before-suffix sort across the file boundary). One rule per name:
 * shadowed lower-precedence answers are not emitted at all. The whole merged
 * list passes through `sortDnsRules`, making the first-match invariant global
 * for the merged consumer. Integrity (`[service-views]`,
 * `[resolver-ambiguous]`) guarantees every multi-view name carries a declared
 * view set, so a drop-out refuses at parse time instead of rendering a
 * promotion.
 *
 * Under `--views` scoping a resolver whose views are ALL filtered out belongs
 * to another org and is skipped; a PARTIALLY filtered resolver is a hard
 * error — rendering a truncated precedence list would be exactly the silent
 * fall-back this renderer exists to kill.
 */

import type { Registry, Entity } from "../schema/registry.ts";
import { isHostService, type Service } from "../schema/service.ts";
import type { Host } from "../schema/host.ts";
import { answerIn, type Answer, type View } from "../schema/view.ts";
import { assertNotCollapsed } from "./collapse.ts";
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

/** The zone-file RR string sing-box's `predefined` action takes. A CNAME
 * target carries the trailing dot so it is absolute, never origin-relative. */
function rrString(dnsName: string, answer: Answer): string {
  const value = answer.type === "CNAME" ? `${answer.value}.` : answer.value;
  return `${dnsName}. IN ${answer.type} ${value}`;
}

/** The service's host entity, or a loud failure for a dangling reference:
 * silently skipping would render the name out of a gateway's table;
 * integrity (`validate`) owns the diagnosis, the render must not lie. */
function hostOf(service: Service, hosts: ReadonlyMap<string, Host>): Host | undefined {
  if (!isHostService(service)) return undefined;
  const host = hosts.get(service.host);
  if (host === undefined) {
    throw new Error(
      `singbox: service "${service.name}" references missing host "${service.host}" — run validate`,
    );
  }
  return host;
}

/** D12 rank: `org-site-band` → 0, unallocated/unknown (incl. public) → 1, `owner-subnet` → 2. */
function viewRank(view: View, entities: readonly Entity[]): number {
  const scope = view.scope;
  if (scope.kind === "public") return 1;
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
  const resolvers = entities.filter((entity) => entity.kind === "resolver");
  const hosts = new Map(
    entities.filter((entity) => entity.kind === "host").map((host) => [host.name, host]),
  );

  const ordered = views
    .map((view) => ({ view, rank: viewRank(view, entities) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.view.name < b.view.name ? -1 : a.view.name > b.view.name ? 1 : 0;
    });

  let emitted = 0;
  const files = ordered.map(({ view }) => {
    const rules: ExactDnsRule[] = [];
    for (const service of services) {
      const answer = answerIn(view, service, hostOf(service, hosts));
      if (answer === undefined) continue;
      rules.push({
        domain: [service.dnsName],
        action: "predefined",
        answer: [rrString(service.dnsName, answer)],
      });
    }
    emitted += rules.length;
    return {
      path: `singbox/dnsrules-${view.name}.json`,
      value: { dnsRules: sortDnsRules(rules) },
    };
  });

  assertNotCollapsed({
    renderer: "singbox",
    services: services.length,
    views: views.length,
    emitted,
    unit: "dnsRules",
  });

  const viewByName = new Map(views.map((view) => [view.name, view]));
  const mergedFiles = [...resolvers]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((resolver) => {
      const present = resolver.views.filter((name) => viewByName.has(name));
      if (present.length === 0) return []; // scoped out entirely — another org's resolver
      if (present.length < resolver.views.length) {
        const missing = resolver.views.filter((name) => !viewByName.has(name));
        throw new Error(
          `singbox: resolver "${resolver.name}" lost view(s) ${missing.join(", ")} to --views scoping ` +
            `but kept ${present.join(", ")} — a truncated precedence list would silently change answers; ` +
            `scope all of the resolver's views in, or none`,
        );
      }
      const rules: ExactDnsRule[] = [];
      for (const service of services) {
        const host = hostOf(service, hosts);
        for (const viewName of resolver.views) {
          const answer = answerIn(viewByName.get(viewName)!, service, host);
          if (answer === undefined) continue;
          rules.push({
            domain: [service.dnsName],
            action: "predefined",
            answer: [rrString(service.dnsName, answer)],
          });
          break; // first listed view with an answer wins; shadowed answers are never emitted
        }
      }
      return [
        {
          path: `singbox/dnsrules-merged-${resolver.name}.json`,
          value: { dnsRules: sortDnsRules(rules) },
        },
      ];
    });

  return [...files, ...mergedFiles];
}

export const singboxRenderer = { name: "singbox", render };

registerRenderer(singboxRenderer);
