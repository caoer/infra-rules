/**
 * `render-surge` — the Surge dconf artifact, rendered to an explicit file.
 *
 * Separate from `render` on purpose: the dconf carries proxy credentials, so
 * it must never appear in the generic multi-target output tree that consuming
 * repos commit (see src/render/surge.ts). The caller names the exact output
 * file; the write is atomic; exit codes follow the render class (D18): 0
 * rendered, 2 failed.
 */

import { readFile } from "node:fs/promises";

import { SurgeLayoutSchema, renderSurge } from "../render/surge.ts";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import { loadRegistry } from "./render.ts";

export interface RenderSurgeOptions {
  registryPath: string;
  layoutPath: string;
  outPath: string;
  /**
   * Registries whose `[Host]` NAMES this profile also needs — another org's
   * mesh whose range this profile already routes. Names only: no proxy exit,
   * pin, policy or routing intent is read from a peer, so a peer publish can
   * never re-route this profile. Order is emit order; repeatable.
   */
  peerRegistryPaths?: readonly string[];
}

export async function runRenderSurge(options: RenderSurgeOptions): Promise<number> {
  const registry = await loadRegistry(options.registryPath);
  const layout = SurgeLayoutSchema.parse(JSON.parse(await readFile(options.layoutPath, "utf8")));
  const peers = [];
  for (const path of options.peerRegistryPaths ?? []) {
    peers.push(await loadRegistry(path));
  }
  const { text, stats } = renderSurge(registry, layout, peers);
  await writeFileAtomic(options.outPath, text);
  console.error(
    `rendered surge dconf to ${options.outPath} ` +
      `(${stats.proxies} proxies, ${stats.pins} pins in ${stats.pinRegions} regions, ` +
      `${stats.unmapped} unmapped, ${stats.intents} intents, ${stats.catchAlls} catch-alls, ` +
      `${stats.hosts} hosts, ${stats.serviceNames} service names` +
      (peers.length > 0
        ? `, ${stats.peerNames} peer names (${stats.peerRules} routed) from ${peers.length} peer(s)`
        : "") +
      `)`,
  );
  return 0;
}
