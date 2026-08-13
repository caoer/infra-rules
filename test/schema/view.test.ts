import { describe, expect, test } from "bun:test";
import type { Host } from "../../src/schema/host.ts";
import { HostSchema } from "../../src/schema/host.ts";
import { ViewSchema, answerFor } from "../../src/schema/view.ts";

const meshView = ViewSchema.parse({
  kind: "view",
  name: "lab-mesh-view",
  scope: { kind: "mesh", mesh: "lab-mesh" },
});

const lanView = ViewSchema.parse({
  kind: "view",
  name: "lab-lan-view",
  scope: { kind: "network", network: "lab-lan" },
});

const host: Host = HostSchema.parse({
  kind: "host",
  name: "alpha",
  mesh: "lab-mesh",
  easytier_ip: "10.99.1.10",
  networks: { "lab-lan": { ip: "192.0.2.10" } },
});

describe("ViewSchema", () => {
  test("happy path: mesh-scoped and network-scoped views parse", () => {
    expect(meshView.scope.kind).toBe("mesh");
    expect(lanView.scope.kind).toBe("network");
  });

  test("a view without a scope is rejected — view is never a free label", () => {
    expect(ViewSchema.safeParse({ kind: "view", name: "floating" }).success).toBe(false);
  });
});

describe("answerFor — computed per-view answers", () => {
  test("mesh view answers the mesh IP; LAN view answers the LAN IP", () => {
    expect(answerFor(meshView, host)).toBe("10.99.1.10");
    expect(answerFor(lanView, host)).toBe("192.0.2.10");
  });

  test("no answer for this view = omit, never fall back", () => {
    // Host with a mesh IP but no presence on lab-lan: the LAN view must NOT
    // hand out the mesh IP.
    const meshOnly = HostSchema.parse({
      kind: "host",
      name: "bravo",
      mesh: "lab-mesh",
      easytier_ip: "10.99.1.11",
    });
    expect(answerFor(lanView, meshOnly)).toBeUndefined();

    // Host on the LAN but not in the mesh: the mesh view must NOT hand out
    // the LAN IP.
    const lanOnly = HostSchema.parse({
      kind: "host",
      name: "charlie",
      networks: { "lab-lan": { ip: "192.0.2.12" } },
    });
    expect(answerFor(meshView, lanOnly)).toBeUndefined();
  });

  test("membership is scope-exact: same address field, different mesh → omit", () => {
    const otherMesh = HostSchema.parse({
      kind: "host",
      name: "delta",
      mesh: "other-mesh",
      easytier_ip: "10.98.1.10",
    });
    expect(answerFor(meshView, otherMesh)).toBeUndefined();
  });

  test("member without an address → omit (membership alone answers nothing)", () => {
    const memberNoIp = HostSchema.parse({ kind: "host", name: "echo", mesh: "lab-mesh" });
    expect(answerFor(meshView, memberNoIp)).toBeUndefined();
  });
});
