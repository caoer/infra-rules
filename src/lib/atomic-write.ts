/**
 * Atomic, all-or-nothing artifact writes.
 *
 * A render either lands completely or leaves the tree exactly as it found it.
 * A half-written set of artifacts is worse than none: the consuming nix repos
 * would build from a mix of old and new.
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

/** Absolute (or cwd-relative) path → file contents. */
export type FileSet = Map<string, string>;

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write one file via temp + rename in the same directory (same-filesystem rename is atomic). */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, contents, "utf8");
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Write every file or none of them.
 *
 * All temps are staged first, then renamed. If a rename fails partway, the
 * already-renamed targets are restored to their previous contents (or removed
 * if they did not exist) and the original error is rethrown.
 */
export async function writeAllOrNothing(files: FileSet): Promise<void> {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const staged: Array<{ path: string; temp: string; previous: string | null }> = [];

  try {
    for (const [path, contents] of entries) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const previous = await readIfExists(path);
      const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
      await writeFile(temp, contents, "utf8");
      staged.push({ path, temp, previous });
    }
  } catch (err) {
    await Promise.all(staged.map((s) => rm(s.temp, { force: true })));
    throw err;
  }

  const committed: typeof staged = [];
  try {
    for (const entry of staged) {
      await rename(entry.temp, entry.path);
      committed.push(entry);
    }
  } catch (err) {
    for (const entry of committed) {
      if (entry.previous === null) await rm(entry.path, { force: true });
      else await writeFile(entry.path, entry.previous, "utf8");
    }
    await Promise.all(staged.map((s) => rm(s.temp, { force: true })));
    throw err;
  }
}
