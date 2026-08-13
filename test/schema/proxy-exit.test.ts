import { describe, expect, test } from "bun:test";
import { ProxyExitSchema } from "../../src/schema/proxy-exit.ts";

// Fixture credentials are deliberately fake; the Unit 2 leak-guard test
// enforces that nothing real ever lands under fixtures/ or test/.
const fake = {
  kind: "proxyExit",
  name: "exit-fixture",
  host: "203.0.113.9",
  port: 8388,
  method: "aes-128-gcm",
  password: "fixture-not-a-real-secret",
} as const;

describe("ProxyExitSchema", () => {
  test("happy path", () => {
    expect(ProxyExitSchema.parse(fake).name).toBe("exit-fixture");
  });

  test("all credential fields are required", () => {
    for (const key of ["host", "port", "method", "password"] as const) {
      const { [key]: _omitted, ...rest } = fake;
      expect(ProxyExitSchema.safeParse(rest).success).toBe(false);
    }
  });

  test("port bounds enforced", () => {
    expect(ProxyExitSchema.safeParse({ ...fake, port: 0 }).success).toBe(false);
  });
});
