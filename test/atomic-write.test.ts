import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeAllOrNothing, writeFileAtomic } from "../src/lib/atomic-write.ts";

let dir: string;

beforeEach(async () => {
  await mkdir(join(import.meta.dir, ".tmp"), { recursive: true });
  dir = await mkdtemp(join(import.meta.dir, ".tmp", "atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes the file and leaves no temp behind", async () => {
    const path = join(dir, "nested", "a.json");
    await writeFileAtomic(path, "one\n");
    expect(await readFile(path, "utf8")).toBe("one\n");
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });

  test("overwrites in place", async () => {
    const path = join(dir, "a.json");
    await writeFileAtomic(path, "one\n");
    await writeFileAtomic(path, "two\n");
    expect(await readFile(path, "utf8")).toBe("two\n");
  });
});

describe("writeAllOrNothing", () => {
  test("writes every file when all targets are writable", async () => {
    await writeAllOrNothing(
      new Map([
        [join(dir, "a.json"), "a\n"],
        [join(dir, "sub", "b.json"), "b\n"],
      ]),
    );
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("a\n");
    expect(await readFile(join(dir, "sub", "b.json"), "utf8")).toBe("b\n");
  });

  test("a staging failure leaves no artifact at all", async () => {
    // `blocker` is a file, so creating `blocker/` for the second target fails.
    await writeFile(join(dir, "blocker"), "occupied\n");
    const files = new Map([
      [join(dir, "a.json"), "a\n"],
      [join(dir, "blocker", "b.json"), "b\n"],
    ]);

    await expect(writeAllOrNothing(files)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["blocker"]);
  });

  test("a commit failure rolls the already-renamed targets back", async () => {
    await writeFile(join(dir, "a.json"), "original\n");
    // A directory cannot be replaced by a rename from a file: the second commit fails.
    await mkdir(join(dir, "b.json"));
    const files = new Map([
      [join(dir, "a.json"), "rendered\n"],
      [join(dir, "b.json"), "rendered\n"],
    ]);

    await expect(writeAllOrNothing(files)).rejects.toThrow();
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("original\n");
    expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);
  });

  test("a rollback removes targets that did not exist before", async () => {
    await mkdir(join(dir, "z.json"));
    const files = new Map([
      [join(dir, "a.json"), "rendered\n"],
      [join(dir, "z.json"), "rendered\n"],
    ]);

    await expect(writeAllOrNothing(files)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["z.json"]);
  });
});
