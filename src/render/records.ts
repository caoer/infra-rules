/**
 * DNS records, one static zone-like file per view.
 *
 * The file is the deliverable a human reads to answer one question: "what
 * does this name resolve to from here?" — and the input `publish cloudflare`
 * upserts into a zone (D1 supersedes the old "no API sync" ruling). So each
 * file names its view, states the vantage it speaks for, and lists its
 * records sorted by DNS name. A record is `{name, type, value}` plus `host`
 * when the value was computed from a host entity; `type` is `A` for every
 * computed answer and `A` or `CNAME` for a static one.
 *
 * THE RULE THIS RENDERER EXISTS TO KEEP: a mesh address is never emitted for
 * a non-mesh vantage. It is kept by construction, not by a check here — every
 * value comes from `answerIn` (Unit 1), the only function that can turn a
 * (view, service) pair into an answer: a host-backed service reaches only
 * the address field its view's scope names, and a static answer surfaces
 * only in a `public` view. When it returns `undefined` the name simply has
 * no answer in this view and the record is OMITTED — there is no default,
 * no fallback to another view's address, and no "closest" address.
 */

import { registerRenderer, type RenderedFile } from "./index.ts";
import { assertNotCollapsed } from "./collapse.ts";
import type { JsonObject } from "../lib/canonical.ts";
import type { Entity, Registry } from "../schema/registry.ts";
import type { Host } from "../schema/host.ts";
import { isHostService } from "../schema/service.ts";
import { answerIn, type View } from "../schema/view.ts";

/** Every entity, both sections. Order is irrelevant — output is name-sorted. */
function entities(registry: Registry): Entity[] {
  return [...Object.values(registry.snapshots).flat(), ...registry.hand];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The view's vantage, restated in the file so it is readable standalone. */
function scopeOf(view: View): JsonObject {
  const scope = view.scope;
  switch (scope.kind) {
    case "mesh":
      return { kind: "mesh", mesh: scope.mesh };
    case "network":
      return { kind: "network", network: scope.network };
    case "public":
      return { kind: "public" };
  }
}

export function renderRecords(registry: Registry): RenderedFile[] {
  const all = entities(registry);

  const views = all
    .filter((entity): entity is Extract<Entity, { kind: "view" }> => entity.kind === "view")
    .sort((a, b) => compare(a.name, b.name));

  // First occurrence wins, matching how integrity.ts resolves by-name refs.
  const hosts = new Map<string, Host>();
  for (const entity of all) {
    if (entity.kind === "host" && !hosts.has(entity.name)) hosts.set(entity.name, entity);
  }

  const services = all
    .filter((entity): entity is Extract<Entity, { kind: "service" }> => entity.kind === "service")
    .sort((a, b) => compare(a.dnsName, b.dnsName));

  let emitted = 0;
  const files = views.map((view) => {
    const records: JsonObject[] = [];

    for (const service of services) {
      const host = isHostService(service) ? hosts.get(service.host) : undefined;
      if (isHostService(service) && host === undefined) {
        // Integrity (Unit 2) rejects this, but `render` parses with the bare
        // envelope schema. Throwing beats omitting: a missing record would
        // read as "this name does not resolve here", which is a lie.
        throw new Error(
          `renderer "records": service "${service.name}" references undeclared host "${service.host}"`,
        );
      }

      const answer = answerIn(view, service, host);
      if (answer === undefined) continue; // no answer in this view — omit

      records.push({
        name: service.dnsName,
        type: answer.type,
        value: answer.value,
        ...(answer.host === undefined ? {} : { host: answer.host }),
      });
    }

    emitted += records.length;
    return {
      path: `records/${view.name}.json`,
      value: { view: view.name, scope: scopeOf(view), records },
    };
  });

  assertNotCollapsed({
    renderer: "records",
    services: services.length,
    views: views.length,
    emitted,
    unit: "records",
  });
  return files;
}

registerRenderer({ name: "records", render: renderRecords });
