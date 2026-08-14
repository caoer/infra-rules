/**
 * DNS records, one static zone-like file per view.
 *
 * v1 renders a file and stops there — no Cloudflare API sync (D10). The file
 * IS the deliverable, and a human reads it to answer one question: "what does
 * this name resolve to from here?". So each file names its view, states the
 * vantage it speaks for, and lists its records sorted by DNS name.
 *
 * THE RULE THIS RENDERER EXISTS TO KEEP: a mesh address is never emitted for
 * a non-mesh vantage. It is kept by construction, not by a check here — every
 * value comes from `answerFor` (Unit 1), the only function that can turn a
 * (view, host) pair into an address, and it can reach only the address field
 * its own scope names. When it returns `undefined` the host simply has no
 * answer in this view and the record is OMITTED — there is no default, no
 * fallback to another view's address, and no "closest" address.
 */

import { registerRenderer, type RenderedFile } from "./index.ts";
import { assertNotCollapsed } from "./collapse.ts";
import type { JsonObject } from "../lib/canonical.ts";
import type { Entity, Registry } from "../schema/registry.ts";
import type { Host } from "../schema/host.ts";
import { answerFor, type View } from "../schema/view.ts";

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
  return scope.kind === "mesh"
    ? { kind: "mesh", mesh: scope.mesh }
    : { kind: "network", network: scope.network };
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
      const host = hosts.get(service.host);
      if (host === undefined) {
        // Integrity (Unit 2) rejects this, but `render` parses with the bare
        // envelope schema. Throwing beats omitting: a missing record would
        // read as "this name does not resolve here", which is a lie.
        throw new Error(
          `renderer "records": service "${service.name}" references undeclared host "${service.host}"`,
        );
      }

      const address = answerFor(view, host);
      if (address === undefined) continue; // no answer in this view — omit

      records.push({ name: service.dnsName, type: "A", value: address, host: host.name });
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
