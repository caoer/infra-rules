import { describe, expect, test } from "bun:test";
import { MeshSchema } from "../../src/schema/mesh.ts";

describe("MeshSchema", () => {
  test("happy path", () => {
    const mesh = MeshSchema.parse({
      kind: "mesh",
      name: "lab-mesh",
      cidr: "10.99.0.0/16",
      allocation: { vocabulary: "owner-subnet", owner: "zed", subnet: "10.99.1.0/24" },
    });
    expect(mesh.name).toBe("lab-mesh");
  });

  test("cidr and allocation are optional", () => {
    expect(MeshSchema.safeParse({ kind: "mesh", name: "thin" }).success).toBe(true);
  });
});
