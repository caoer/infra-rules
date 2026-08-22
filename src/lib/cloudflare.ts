/**
 * The Cloudflare DNS API surface `publish cloudflare` needs — and nothing
 * else. Five calls over `fetch`, all through one `request` helper, so a test
 * stubs ONE function and sees every wire payload.
 *
 * Every record this module writes is `proxied: false` (DNS-only). The zone
 * may carry a proxied wildcard; explicit records must answer as plain DNS so
 * mesh-private addresses and origin-terminated TLS work. `ttl: 1` is
 * Cloudflare's "auto".
 */

export interface CfRecordSpec {
  type: "A" | "CNAME";
  /** Fully-qualified name, no trailing dot. */
  name: string;
  content: string;
  comment: string;
}

export interface CfRecord extends CfRecordSpec {
  id: string;
}

export interface CloudflareApi {
  /** The zone id for a zone name; throws when the token sees no such zone. */
  zoneId(zoneName: string): Promise<string>;
  /** Every A/CNAME record in the zone (other types are not ours to touch). */
  listRecords(zoneId: string): Promise<CfRecord[]>;
  createRecord(zoneId: string, spec: CfRecordSpec): Promise<void>;
  updateRecord(zoneId: string, recordId: string, spec: CfRecordSpec): Promise<void>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 1000;

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

/** Wire body for create/update: the spec plus the two fixed DNS-only fields. */
function payload(spec: CfRecordSpec): Record<string, unknown> {
  return {
    type: spec.type,
    name: spec.name,
    content: spec.content,
    comment: spec.comment,
    proxied: false,
    ttl: 1,
  };
}

export function cloudflareApi(token: string, fetchImpl: FetchLike = fetch): CloudflareApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(`cloudflare ${method} ${path}: HTTP ${response.status}, non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!response.ok || !envelope.success) {
      const reasons = (envelope.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? "?"}`).join("; ");
      throw new Error(`cloudflare ${method} ${path}: HTTP ${response.status} ${reasons || text.slice(0, 200)}`);
    }
    return envelope;
  }

  return {
    async zoneId(zoneName) {
      const { result } = await request<Array<{ id: string; name: string }>>(
        "GET",
        `/zones?name=${encodeURIComponent(zoneName)}`,
      );
      const zone = result.find((z) => z.name === zoneName);
      if (zone === undefined) throw new Error(`cloudflare: no zone named "${zoneName}" visible to this token`);
      return zone.id;
    },

    async listRecords(zoneId) {
      const records: CfRecord[] = [];
      for (let page = 1; ; page++) {
        const { result, result_info } = await request<
          Array<{ id: string; type: string; name: string; content: string; comment?: string | null }>
        >("GET", `/zones/${zoneId}/dns_records?per_page=${PAGE_SIZE}&page=${page}`);
        for (const r of result) {
          if (r.type !== "A" && r.type !== "CNAME") continue;
          records.push({ id: r.id, type: r.type, name: r.name, content: r.content, comment: r.comment ?? "" });
        }
        if (result_info === undefined || page >= result_info.total_pages) return records;
      }
    },

    async createRecord(zoneId, spec) {
      await request("POST", `/zones/${zoneId}/dns_records`, payload(spec));
    },

    async updateRecord(zoneId, recordId, spec) {
      await request("PUT", `/zones/${zoneId}/dns_records/${recordId}`, payload(spec));
    },

    async deleteRecord(zoneId, recordId) {
      await request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
    },
  };
}
