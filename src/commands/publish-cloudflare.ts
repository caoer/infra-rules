/**
 * `publish cloudflare` — upsert rendered `records/<view>.json` files into a
 * Cloudflare zone (D1 supersedes the old "render stops at JSON" ruling).
 *
 * OWNERSHIP. Every record this command writes carries the comment
 * `infra-rules:<view>`. That comment is the only thing it will ever delete:
 * a record without it is somebody's hand-made answer, and a desired name
 * that collides with one REFUSES rather than adding a second answer or
 * overwriting it. A delete is scoped to the views present in the input —
 * publishing `public.json` alone never touches `infra-rules:coscene-mesh`
 * records.
 *
 * ONE ANSWER PER NAME. A name is keyed alone (not name+type): in this model
 * a name is either one A or one CNAME, and a name appearing in two input
 * files is a registry precedence question the publisher must not answer —
 * it refuses.
 *
 * Records outside the zone are skipped and listed (a view file may carry
 * names from several zones); an input whose records ALL fall outside the
 * zone is a typo, not a no-op, and fails.
 *
 * The plan is printed before anything is applied; `--dry-run` stops there.
 * A second run against the same input is zero changes. Exit codes (D18
 * render class): 0 ok, 2 failed.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

import { cloudflareApi, type CfRecord, type CfRecordSpec, type CloudflareApi } from "../lib/cloudflare.ts";

export const OWNER_PREFIX = "infra-rules:";

/** The `records/<view>.json` shape `render` writes (header included). */
const RecordsFileSchema = z.object({
  _generated: z.string().optional(),
  view: z.string().min(1),
  scope: z.unknown(),
  records: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(["A", "CNAME"]),
      value: z.string().min(1),
      host: z.string().optional(),
    }),
  ),
});

export interface Desired extends CfRecordSpec {
  view: string;
}

export interface Plan {
  create: Desired[];
  update: Array<{ before: CfRecord; after: Desired }>;
  delete: CfRecord[];
  unchanged: number;
}

export function ownerOf(record: { comment: string }): string | undefined {
  return record.comment.startsWith(OWNER_PREFIX) ? record.comment.slice(OWNER_PREFIX.length) : undefined;
}

function inZone(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

/**
 * Records files → the desired set for one zone. Names are lowercased (DNS is
 * case-insensitive and Cloudflare stores lowercase); a name claimed by two
 * files refuses; names outside the zone are returned separately.
 */
export function desiredFromFiles(
  files: Array<{ path: string; contents: unknown }>,
  zone: string,
): { desired: Desired[]; skipped: string[]; views: Set<string> } {
  const desired: Desired[] = [];
  const skipped: string[] = [];
  const views = new Set<string>();
  const claimedBy = new Map<string, string>();

  for (const file of files) {
    const parsed = RecordsFileSchema.safeParse(file.contents);
    if (!parsed.success) {
      throw new Error(`${file.path}: not a records file — ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const { view, records } = parsed.data;
    views.add(view);
    for (const record of records) {
      const name = record.name.toLowerCase();
      if (!inZone(name, zone)) {
        skipped.push(name);
        continue;
      }
      const other = claimedBy.get(name);
      if (other !== undefined) {
        throw new Error(
          `name ${name} appears in views "${other}" and "${view}" — one zone holds one answer per name; ` +
            `publish one view's file for it (or fix the registry's view declarations)`,
        );
      }
      claimedBy.set(name, view);
      const content = record.type === "CNAME" ? record.value.toLowerCase() : record.value;
      desired.push({ name, type: record.type, content, comment: `${OWNER_PREFIX}${view}`, view });
    }
  }
  return { desired, skipped: [...new Set(skipped)].sort(), views };
}

/** The pure diff: desired vs the zone's current A/CNAME records. */
export function planPublish(desired: Desired[], existing: CfRecord[], inputViews: Set<string>): Plan {
  const byName = new Map<string, CfRecord[]>();
  for (const record of existing) {
    const name = record.name.toLowerCase();
    const group = byName.get(name);
    if (group) group.push(record);
    else byName.set(name, [record]);
  }

  const plan: Plan = { create: [], update: [], delete: [], unchanged: 0 };
  const wanted = new Set<string>();

  for (const want of [...desired].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    wanted.add(want.name);
    const current = byName.get(want.name) ?? [];
    const foreign = current.filter((r) => ownerOf(r) === undefined);
    if (foreign.length > 0) {
      const listing = foreign.map((r) => `${r.type} ${r.content}${r.comment ? ` (comment "${r.comment}")` : ""}`).join(", ");
      throw new Error(
        `name ${want.name} already carries ${foreign.length} record(s) not owned by infra-rules: ${listing} — ` +
          `refusing to add a second answer or overwrite a hand-made one; delete it or set its comment to ${OWNER_PREFIX}<view>`,
      );
    }
    const owned = current.filter((r) => ownerOf(r) !== undefined);
    const [head, ...extra] = owned;
    if (head === undefined) {
      plan.create.push(want);
    } else if (head.type === want.type && head.content === want.content && head.comment === want.comment) {
      plan.unchanged++;
    } else {
      plan.update.push({ before: head, after: want });
    }
    plan.delete.push(...extra); // duplicates we once created: converge to one
  }

  for (const record of existing) {
    const owner = ownerOf(record);
    if (owner === undefined || !inputViews.has(owner)) continue;
    if (wanted.has(record.name.toLowerCase())) continue;
    plan.delete.push(record);
  }
  plan.delete.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return plan;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatPlan(plan: Plan): string[] {
  const lines: string[] = [];
  const line = (mark: string, type: string, name: string, value: string, comment: string) =>
    lines.push(`  ${mark} ${pad(type, 5)} ${pad(name, 40)} ${value}  [${comment}]`);
  for (const r of plan.create) line("+", r.type, r.name, r.content, r.comment);
  for (const { before, after } of plan.update) {
    const value =
      before.type === after.type && before.content === after.content
        ? after.content
        : `${before.type} ${before.content} → ${after.type} ${after.content}`;
    const comment = before.comment === after.comment ? after.comment : `${before.comment} → ${after.comment}`;
    line("~", after.type, after.name, value, comment);
  }
  for (const r of plan.delete) line("-", r.type, r.name, r.content, r.comment);
  lines.push(
    `plan: ${plan.create.length} create, ${plan.update.length} update, ${plan.delete.length} delete, ${plan.unchanged} unchanged`,
  );
  return lines;
}

export async function applyPlan(api: CloudflareApi, zoneId: string, plan: Plan): Promise<void> {
  // Deletes first: a name moving from A to CNAME (or the reverse) cannot
  // coexist, and a stale duplicate must be gone before its sibling is rewritten.
  for (const record of plan.delete) await api.deleteRecord(zoneId, record.id);
  for (const { before, after } of plan.update) await api.updateRecord(zoneId, before.id, after);
  for (const record of plan.create) await api.createRecord(zoneId, record);
}

export interface PublishCloudflareOptions {
  zone: string;
  recordsPaths: string[];
  dryRun: boolean;
  /** Injected for tests; defaults to the real API with `CF_API_TOKEN`. */
  api?: CloudflareApi;
  log?: (line: string) => void;
}

/** Exit codes: 0 ok (applied, or dry run), 2 failed (thrown). */
export async function runPublishCloudflare(options: PublishCloudflareOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const api = options.api ?? cloudflareApi(tokenFromEnv());

  const files = await Promise.all(
    options.recordsPaths.map(async (path) => ({ path, contents: JSON.parse(await readFile(path, "utf8")) })),
  );
  const { desired, skipped, views } = desiredFromFiles(files, options.zone);
  if (desired.length === 0 && skipped.length > 0) {
    throw new Error(
      `no record in the input belongs to zone ${options.zone} (saw ${skipped.slice(0, 5).join(", ")}${
        skipped.length > 5 ? ", …" : ""
      }) — wrong --zone?`,
    );
  }

  const zoneId = await api.zoneId(options.zone);
  const existing = await api.listRecords(zoneId);
  const plan = planPublish(desired, existing, views);

  log(`publish cloudflare — zone ${options.zone} (${zoneId}), views: ${[...views].sort().join(", ")}`);
  for (const line of formatPlan(plan)) log(line);
  if (skipped.length > 0) log(`skipped ${skipped.length} name(s) outside the zone: ${skipped.join(", ")}`);

  if (options.dryRun) {
    log("dry run — nothing applied");
    return 0;
  }
  await applyPlan(api, zoneId, plan);
  log(`applied: ${plan.create.length} created, ${plan.update.length} updated, ${plan.delete.length} deleted`);
  return 0;
}

function tokenFromEnv(): string {
  const token = process.env["CF_API_TOKEN"];
  if (token === undefined || token === "") {
    throw new Error("CF_API_TOKEN is not set — export a Cloudflare API token with DNS edit on the zone");
  }
  return token;
}
