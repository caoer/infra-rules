/**
 * The empty-render guard (src/render/collapse.ts).
 *
 * `surge.ts` refused an empty selection from the start; the other three
 * renderers wrote `{"dnsRules": []}` / `{"records": []}` / empty check lists
 * and let a gateway boot on them. The rule these tests pin: a single empty
 * view is legitimate data, a whole-render collapse is not.
 */

import { describe, expect, test } from "bun:test";

import { renderRecords } from "../../src/render/records.ts";
import { singboxRenderer } from "../../src/render/singbox.ts";
import { renderProbes } from "../../src/render/probes.ts";
import type { Registry } from "../../src/schema/registry.ts";

/** Two views, one host answering only in the mesh view — so the LAN view is
 * legitimately empty while the mesh view is not. */
const healthy: Registry = {
  schemaVersion: 1,
  snapshots: {},
  hand: [
    {
      kind: "mesh",
      name: "lab-mesh",
      cidr: "10.20.0.0/14",
      allocation: { vocabulary: "owner-subnet", owner: "zt-lab", subnet: "10.20.0.0/14" },
    },
    { kind: "network", name: "site-lan", cidr: "192.0.2.0/24" },
    { kind: "host", name: "panel-1", mesh: "lab-mesh", easytier_ip: "10.20.1.5" },
    { kind: "view", name: "meshview", scope: { kind: "mesh", mesh: "lab-mesh" } },
    { kind: "view", name: "lanview", scope: { kind: "network", network: "site-lan" } },
    { kind: "service", name: "panel", dnsName: "panel.acme.test", host: "panel-1", port: 443 },
  ],
};

/** The regression shape: the host lost its addresses, so no view can answer.
 * Every artifact is still structurally valid and completely empty. */
const collapsed: Registry = {
  schemaVersion: 1,
  snapshots: {},
  hand: [
    { kind: "network", name: "site-lan", cidr: "192.0.2.0/24" },
    { kind: "host", name: "panel-1" },
    { kind: "view", name: "lanview", scope: { kind: "network", network: "site-lan" } },
    { kind: "service", name: "panel", dnsName: "panel.acme.test", host: "panel-1", port: 443 },
  ],
};

describe("empty-render guard — a legitimately empty view still renders", () => {
  test("records keeps the empty view and the answering one", () => {
    const files = renderRecords(healthy);
    expect(files.map((file) => file.path).sort()).toEqual([
      "records/lanview.json",
      "records/meshview.json",
    ]);
  });

  test("singbox emits dnsRules: [] for the view with no answer", () => {
    const files = singboxRenderer.render(healthy);
    const lan = files.find((file) => file.path === "singbox/dnsrules-lanview.json");
    expect(lan?.value).toEqual({ dnsRules: [] });
  });

  test("probes keeps the empty section", () => {
    const manifest = renderProbes(healthy);
    expect(manifest.views.find((view) => view.view === "lanview")?.checks).toEqual([]);
  });
});

describe("empty-render guard — a whole-render collapse is refused", () => {
  test("records throws instead of writing empty files", () => {
    expect(() => renderRecords(collapsed)).toThrow(/produced 0 records across every view/);
  });

  test("singbox throws instead of writing dnsRules: [] everywhere", () => {
    expect(() => singboxRenderer.render(collapsed)).toThrow(/produced 0 dnsRules across every view/);
  });

  test("probes throws instead of publishing an all-empty manifest", () => {
    expect(() => renderProbes(collapsed)).toThrow(/produced 0 checks across every view/);
  });

  test("a registry with no services at all is not a collapse — there is nothing to render", () => {
    const empty: Registry = { schemaVersion: 1, snapshots: {}, hand: [] };
    expect(renderRecords(empty)).toEqual([]);
    expect(singboxRenderer.render(empty)).toEqual([]);
    expect(renderProbes(empty).views).toEqual([]);
  });
});
