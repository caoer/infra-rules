/**
 * Renderer: the probes manifest (`probes.json`).
 *
 * One section per view, each holding the checks a vantage resolving in that
 * view must run. Derivation, per service entity:
 *
 *   dnsName          → dns-answer, expecting `answerFor(view, host)`
 *   port             → tcp-connect to that same address
 *   http (+ port)    → http-status against that same address
 *
 * THE OMIT RULE. The expected address is always `answerFor(view, host)`. When
 * it is undefined — the host is not in that view's mesh, or has no address on
 * that view's network — the service contributes NOTHING to that view. It is
 * never defaulted to another view's address: a mesh IP handed to a LAN vantage
 * would make the probe assert a lie and go red forever. This is the whole
 * reason `view` is first-class (Unit 1), and `test/render/probes.test.ts`
 * fails if any other view's address ever appears in a section.
 */

import { registerRenderer, type RenderedFile } from "./index.ts";
import type { JsonObject } from "../lib/canonical.ts";
import type { Registry } from "../schema/registry.ts";
import type { Host } from "../schema/host.ts";
import type { Service } from "../schema/service.ts";
import type { View } from "../schema/view.ts";
import { answerFor } from "../schema/view.ts";
import { PROBE_MANIFEST_VERSION, type ProbeCheck, type ProbeManifest } from "../schema/probe.ts";

/** Defaults for an `http` block that omits them, so the exporter needs none. */
const DEFAULT_HTTP_PATH = "/";
const DEFAULT_HTTP_STATUS = 200;

/** Every entity in the registry, snapshots before hand — the order integrity.ts
 * resolves references in (first occurrence wins). */
function allEntities(registry: Registry) {
  return [...Object.values(registry.snapshots).flat(), ...registry.hand];
}

/** name → first entity of that kind with the name. */
function firstByName<T extends { name: string }>(entities: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entity of entities) if (!map.has(entity.name)) map.set(entity.name, entity);
  return map;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Checks one service contributes to one view; empty when the view has no
 * answer for its host. */
function checksFor(service: Service, host: Host, view: View): ProbeCheck[] {
  const address = answerFor(view, host);
  if (address === undefined) return [];

  const checks: ProbeCheck[] = [
    { service: service.name, check: "dns-answer", dnsName: service.dnsName, expectIp: address },
  ];

  if (service.port !== undefined) {
    checks.push({ service: service.name, check: "tcp-connect", address, port: service.port });
    if (service.http !== undefined) {
      checks.push({
        service: service.name,
        check: "http-status",
        address,
        port: service.port,
        dnsName: service.dnsName,
        path: service.http.path ?? DEFAULT_HTTP_PATH,
        expectStatus: service.http.expectStatus ?? DEFAULT_HTTP_STATUS,
      });
    }
  }

  return checks;
}

export function renderProbes(registry: Registry): ProbeManifest {
  const entities = allEntities(registry);
  const hosts = firstByName(entities.filter((entity) => entity.kind === "host"));
  const services = [...firstByName(entities.filter((entity) => entity.kind === "service")).values()];
  const views = [...firstByName(entities.filter((entity) => entity.kind === "view")).values()];

  return {
    manifestVersion: PROBE_MANIFEST_VERSION,
    views: views
      .sort((a, b) => compare(a.name, b.name))
      .map((view) => ({
        view: view.name,
        checks: services
          .flatMap((service) => {
            // A dangling service.host is an integrity error (Unit 2); the
            // renderer skips it rather than inventing an address.
            const host = hosts.get(service.host);
            return host === undefined ? [] : checksFor(service, host, view);
          })
          .sort((a, b) => compare(a.service, b.service) || compare(a.check, b.check)),
      })),
  };
}

registerRenderer({
  name: "probes",
  render(registry): RenderedFile[] {
    return [{ path: "probes.json", value: renderProbes(registry) satisfies JsonObject }];
  },
});
