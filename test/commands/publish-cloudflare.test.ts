/**
 * `publish cloudflare` — the plan is pure, the API is one stubbable surface.
 *
 * Synthetic zone `acme.test`, TEST-NET addresses and a 10.98.x mesh band
 * only. The in-memory `FakeApi` models the zone as Cloudflare would hold it;
 * the wire test stubs `fetch` to see the exact bodies the real module sends.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudflareApi, type CfRecord, type CfRecordSpec, type CloudflareApi } from "../../src/lib/cloudflare.ts";
import {
  OWNER_PREFIX,
  desiredFromFiles,
  planPublish,
  runPublishCloudflare,
} from "../../src/commands/publish-cloudflare.ts";

const ZONE = "acme.test";

/** A records file as `render` writes it. */
function recordsFile(view: string, records: Array<{ name: string; type: "A" | "CNAME"; value: string; host?: string }>) {
  return { _generated: "DO NOT EDIT", view, scope: { kind: "public" }, records };
}

/** Cloudflare's zone, in memory. Every write lands here; `calls` is the audit log. */
class FakeApi implements CloudflareApi {
  records: CfRecord[];
  calls: string[] = [];
  private next = 1;
  constructor(seed: Array<Omit<CfRecord, "id">> = []) {
    this.records = seed.map((r) => ({ ...r, id: `r${this.next++}` }));
  }
  async zoneId(zoneName: string): Promise<string> {
    if (zoneName !== ZONE) throw new Error(`no zone ${zoneName}`);
    return "zone-1";
  }
  async listRecords(): Promise<CfRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
  async createRecord(_zone: string, spec: CfRecordSpec): Promise<void> {
    this.calls.push(`create ${spec.type} ${spec.name} ${spec.content} [${spec.comment}]`);
    this.records.push({ ...spec, id: `r${this.next++}` });
  }
  async updateRecord(_zone: string, id: string, spec: CfRecordSpec): Promise<void> {
    this.calls.push(`update ${id} ${spec.type} ${spec.name} ${spec.content} [${spec.comment}]`);
    const i = this.records.findIndex((r) => r.id === id);
    if (i === -1) throw new Error(`update of unknown record ${id}`);
    this.records[i] = { ...spec, id };
  }
  async deleteRecord(_zone: string, id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
    const i = this.records.findIndex((r) => r.id === id);
    if (i === -1) throw new Error(`delete of unknown record ${id}`);
    this.records.splice(i, 1);
  }
}

async function writeInputs(files: Record<string, unknown>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "infra-rules-publish-"));
  const paths: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(contents));
    paths.push(path);
  }
  return paths;
}

async function publish(api: FakeApi, paths: string[], dryRun = false): Promise<{ code: number; log: string[] }> {
  const log: string[] = [];
  const code = await runPublishCloudflare({ zone: ZONE, recordsPaths: paths, dryRun, api, log: (l) => log.push(l) });
  return { code, log };
}

const MESH = recordsFile("mesh", [
  { name: "gw.site1.acme.test", type: "A", value: "10.98.1.10", host: "gw-1" },
  { name: "dashboard.other.example", type: "A", value: "10.98.1.11", host: "svc-1" },
]);
const PUBLIC = recordsFile("public", [
  { name: "entry.hq.acme.test", type: "CNAME", value: "office-gw.upstream.test" },
  { name: "entry.site1.acme.test", type: "A", value: "203.0.113.75" },
]);

describe("desiredFromFiles — the input set", () => {
  test("lowercases names, tags each record with its view's owner comment, skips names outside the zone", () => {
    const { desired, skipped, views } = desiredFromFiles(
      [
        { path: "mesh.json", contents: MESH },
        { path: "public.json", contents: PUBLIC },
      ],
      ZONE,
    );
    expect(desired.map((d) => `${d.type} ${d.name} ${d.content} ${d.comment}`)).toEqual([
      "A gw.site1.acme.test 10.98.1.10 infra-rules:mesh",
      "CNAME entry.hq.acme.test office-gw.upstream.test infra-rules:public",
      "A entry.site1.acme.test 203.0.113.75 infra-rules:public",
    ]);
    expect(skipped).toEqual(["dashboard.other.example"]);
    expect([...views].sort()).toEqual(["mesh", "public"]);
  });

  test("a name claimed by two views refuses — the publisher never picks precedence", () => {
    const again = recordsFile("lan", [{ name: "gw.site1.acme.test", type: "A", value: "192.0.2.10" }]);
    expect(() =>
      desiredFromFiles(
        [
          { path: "mesh.json", contents: MESH },
          { path: "lan.json", contents: again },
        ],
        ZONE,
      ),
    ).toThrow(/gw\.site1\.acme\.test appears in views "mesh" and "lan"/);
  });

  test("a file that is not a records file refuses by path", () => {
    expect(() => desiredFromFiles([{ path: "probes.json", contents: { views: [] } }], ZONE)).toThrow(
      /probes\.json: not a records file/,
    );
  });
});

describe("planPublish — ownership decides every delete", () => {
  const own = (view: string) => `${OWNER_PREFIX}${view}`;
  const { desired, views } = desiredFromFiles([{ path: "public.json", contents: PUBLIC }], ZONE);

  test("an empty zone: everything is a create", () => {
    const plan = planPublish(desired, [], views);
    expect(plan.create.map((r) => r.name)).toEqual(["entry.hq.acme.test", "entry.site1.acme.test"]);
    expect(plan.update).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  test("an owned record with a different value is updated in place; a matching one is unchanged", () => {
    const existing: CfRecord[] = [
      { id: "a", type: "A", name: "entry.site1.acme.test", content: "203.0.113.1", comment: own("public") },
      { id: "b", type: "CNAME", name: "entry.hq.acme.test", content: "office-gw.upstream.test", comment: own("public") },
    ];
    const plan = planPublish(desired, existing, views);
    expect(plan.update.map((u) => `${u.before.id} ${u.before.content} → ${u.after.content}`)).toEqual([
      "a 203.0.113.1 → 203.0.113.75",
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.create).toEqual([]);
  });

  test("only owned records of the INPUT views are deleted when absent; other views' and foreign records stay", () => {
    const existing: CfRecord[] = [
      { id: "stale", type: "A", name: "old.acme.test", content: "203.0.113.9", comment: own("public") },
      { id: "mesh", type: "A", name: "gw.site1.acme.test", content: "10.98.1.10", comment: own("mesh") },
      { id: "hand", type: "A", name: "hand.acme.test", content: "203.0.113.8", comment: "" },
      { id: "wild", type: "CNAME", name: "*.acme.test", content: "tunnel.example", comment: "hand-made" },
    ];
    const plan = planPublish(desired, existing, views);
    expect(plan.delete.map((r) => r.id)).toEqual(["stale"]);
  });

  test("a foreign record at a desired name refuses — never a second answer, never an overwrite", () => {
    const existing: CfRecord[] = [
      { id: "h", type: "A", name: "entry.site1.acme.test", content: "203.0.113.1", comment: "" },
    ];
    expect(() => planPublish(desired, existing, views)).toThrow(
      /entry\.site1\.acme\.test already carries 1 record\(s\) not owned by infra-rules/,
    );
  });

  test("a name moving views is an update of the owner comment, not delete+create", () => {
    const existing: CfRecord[] = [
      { id: "m", type: "A", name: "entry.site1.acme.test", content: "203.0.113.75", comment: own("mesh") },
    ];
    const plan = planPublish(desired, existing, views);
    expect(plan.update.map((u) => `${u.before.comment} → ${u.after.comment}`)).toEqual([
      "infra-rules:mesh → infra-rules:public",
    ]);
    expect(plan.delete).toEqual([]);
  });
});

describe("runPublishCloudflare — end to end against an in-memory zone", () => {
  test("first run creates, second run is a no-op; the plan is printed before anything lands", async () => {
    const api = new FakeApi();
    const paths = await writeInputs({ "mesh.json": MESH, "public.json": PUBLIC });

    const first = await publish(api, paths);
    expect(first.code).toBe(0);
    expect(first.log.join("\n")).toContain("plan: 3 create, 0 update, 0 delete, 0 unchanged");
    expect(first.log.join("\n")).toContain("skipped 1 name(s) outside the zone: dashboard.other.example");
    expect(api.calls).toEqual([
      "create CNAME entry.hq.acme.test office-gw.upstream.test [infra-rules:public]",
      "create A entry.site1.acme.test 203.0.113.75 [infra-rules:public]",
      "create A gw.site1.acme.test 10.98.1.10 [infra-rules:mesh]",
    ]);

    api.calls = [];
    const second = await publish(api, paths);
    expect(second.code).toBe(0);
    expect(second.log.join("\n")).toContain("plan: 0 create, 0 update, 0 delete, 3 unchanged");
    expect(api.calls).toEqual([]);
  });

  test("--dry-run prints the plan and writes nothing", async () => {
    const api = new FakeApi();
    const paths = await writeInputs({ "public.json": PUBLIC });
    const { code, log } = await publish(api, paths, true);
    expect(code).toBe(0);
    expect(log.at(-1)).toBe("dry run — nothing applied");
    expect(api.calls).toEqual([]);
    expect(api.records).toEqual([]);
  });

  test("a record dropped from its view's file is deleted; an A→CNAME change deletes nothing extra", async () => {
    const api = new FakeApi([
      { type: "A", name: "entry.hq.acme.test", content: "203.0.113.2", comment: `${OWNER_PREFIX}public` },
      { type: "A", name: "gone.acme.test", content: "203.0.113.3", comment: `${OWNER_PREFIX}public` },
      { type: "A", name: "gw.site1.acme.test", content: "10.98.1.10", comment: `${OWNER_PREFIX}mesh` },
    ]);
    const paths = await writeInputs({ "public.json": PUBLIC });
    const { log } = await publish(api, paths);
    expect(log.join("\n")).toContain("plan: 1 create, 1 update, 1 delete, 0 unchanged");
    expect(api.calls).toEqual([
      "delete r2",
      "update r1 CNAME entry.hq.acme.test office-gw.upstream.test [infra-rules:public]",
      "create A entry.site1.acme.test 203.0.113.75 [infra-rules:public]",
    ]);
    // The mesh view was not in the input: its record is untouched.
    expect(api.records.find((r) => r.name === "gw.site1.acme.test")).toBeDefined();
  });

  test("an input whose records all fall outside the zone fails instead of reporting a clean no-op", async () => {
    const api = new FakeApi();
    const paths = await writeInputs({
      "other.json": recordsFile("mesh", [{ name: "x.other.example", type: "A", value: "10.98.1.1" }]),
    });
    await expect(publish(api, paths)).rejects.toThrow(/no record in the input belongs to zone acme\.test/);
    expect(api.calls).toEqual([]);
  });
});

describe("cloudflareApi — the wire", () => {
  /** Records every request; answers from a script keyed by `METHOD path`. */
  function stubFetch(answers: Record<string, unknown>) {
    const seen: Array<{ method: string; url: string; body: unknown; auth: string | undefined }> = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      const key = `${init.method} ${url.replace("https://api.cloudflare.com/client/v4", "")}`;
      const headers = init.headers as Record<string, string>;
      seen.push({ method: init.method!, url, body: init.body ? JSON.parse(init.body as string) : undefined, auth: headers["Authorization"] });
      const answer = answers[key];
      if (answer === undefined) return new Response(JSON.stringify({ success: false, errors: [{ code: 404, message: `no stub for ${key}` }], result: null }), { status: 404 });
      return new Response(JSON.stringify({ success: true, errors: [], result: answer, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
    };
    return { seen, fetchImpl };
  }

  test("every create and update is proxied:false with ttl auto and the owner comment; the bearer token rides every call", async () => {
    const { seen, fetchImpl } = stubFetch({
      "POST /zones/z1/dns_records": { id: "new" },
      "PUT /zones/z1/dns_records/r9": { id: "r9" },
    });
    const api = cloudflareApi("fake-token", fetchImpl);
    const spec: CfRecordSpec = { type: "A", name: "entry.site1.acme.test", content: "203.0.113.75", comment: "infra-rules:public" };
    await api.createRecord("z1", spec);
    await api.updateRecord("z1", "r9", { ...spec, type: "CNAME", content: "office-gw.upstream.test" });

    expect(seen.map((s) => s.auth)).toEqual(["Bearer fake-token", "Bearer fake-token"]);
    expect(seen[0]!.body).toEqual({
      type: "A",
      name: "entry.site1.acme.test",
      content: "203.0.113.75",
      comment: "infra-rules:public",
      proxied: false,
      ttl: 1,
    });
    expect(seen[1]!.body).toMatchObject({ type: "CNAME", content: "office-gw.upstream.test", proxied: false, ttl: 1 });
    for (const call of seen) expect((call.body as { proxied: boolean }).proxied).toBe(false);
  });

  test("zone lookup matches the exact name; listing keeps A/CNAME only and normalizes a null comment", async () => {
    const { fetchImpl } = stubFetch({
      "GET /zones?name=acme.test": [{ id: "z1", name: "acme.test" }],
      "GET /zones/z1/dns_records?per_page=1000&page=1": [
        { id: "a", type: "A", name: "x.acme.test", content: "203.0.113.1", comment: null },
        { id: "t", type: "TXT", name: "acme.test", content: "v=spf1" },
        { id: "c", type: "CNAME", name: "*.acme.test", content: "tunnel.example", comment: "hand" },
      ],
    });
    const api = cloudflareApi("fake-token", fetchImpl);
    expect(await api.zoneId("acme.test")).toBe("z1");
    expect(await api.listRecords("z1")).toEqual([
      { id: "a", type: "A", name: "x.acme.test", content: "203.0.113.1", comment: "" },
      { id: "c", type: "CNAME", name: "*.acme.test", content: "tunnel.example", comment: "hand" },
    ]);
  });

  test("an API refusal surfaces with Cloudflare's own error text", async () => {
    const { fetchImpl } = stubFetch({});
    const api = cloudflareApi("fake-token", fetchImpl);
    await expect(api.deleteRecord("z1", "nope")).rejects.toThrow(/cloudflare DELETE \/zones\/z1\/dns_records\/nope: HTTP 404 404: no stub/);
  });
});
