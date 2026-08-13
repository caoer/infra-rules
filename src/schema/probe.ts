import { z } from "zod";

/**
 * The probes manifest: the rendered artifact the probe exporter (Unit 5) runs
 * from. It is a committed file in each consuming nix repo (Units 9/10), baked
 * into the module at build time (Unit 11) — the exporter reloads it from disk
 * each cycle and never fetches anything.
 *
 * WHAT A VANTAGE IS HERE. A vantage is a deployed exporter, not a registry
 * entity: deployment owns the `vantage` label and its uniqueness (one exporter
 * per label). What the registry can say is the *view* a vantage resolves in,
 * so the manifest is sectioned by view and the exporter is deployed with a
 * vantage label plus the name of the section it runs. Between them the four
 * D8 labels are covered: `service` and `check` per record, `view` per section,
 * `vantage` from the deployment.
 *
 * Every address in here is `answerFor(view, host)` — the answer in that view
 * and no other. A host with no answer for a view contributes no records to it.
 */

const CheckBase = {
  /** Service entity name — the `service` metric label. */
  service: z.string().min(1),
};

/** Resolve `dnsName` and require the answer to be exactly `expectIp`. */
export const DnsAnswerCheckSchema = z.strictObject({
  ...CheckBase,
  check: z.literal("dns-answer"),
  dnsName: z.hostname(),
  expectIp: z.ipv4(),
});

/** Open a TCP connection to `address:port`. */
export const TcpConnectCheckSchema = z.strictObject({
  ...CheckBase,
  check: z.literal("tcp-connect"),
  address: z.ipv4(),
  port: z.number().int().min(1).max(65535),
});

/**
 * `GET http://address:port/path` with `Host: dnsName`, expecting `expectStatus`.
 * The address is resolved here, not by the exporter, so the request never
 * depends on the exporter host's resolver.
 */
export const HttpStatusCheckSchema = z.strictObject({
  ...CheckBase,
  check: z.literal("http-status"),
  address: z.ipv4(),
  port: z.number().int().min(1).max(65535),
  dnsName: z.hostname(),
  path: z.string().startsWith("/"),
  expectStatus: z.number().int().min(100).max(599),
});

export const ProbeCheckSchema = z.discriminatedUnion("check", [
  DnsAnswerCheckSchema,
  TcpConnectCheckSchema,
  HttpStatusCheckSchema,
]);

export type ProbeCheck = z.infer<typeof ProbeCheckSchema>;

/** One view's checks. `checks` is empty — never absent, never null — when the
 * view has no answerable service, so a silent vantage is visible as zero
 * checks rather than a missing section. */
export const ProbeViewSchema = z.strictObject({
  view: z.string().min(1),
  checks: z.array(ProbeCheckSchema),
});

export type ProbeView = z.infer<typeof ProbeViewSchema>;

/** Bump on any breaking manifest shape change; the exporter asserts it. */
export const PROBE_MANIFEST_VERSION = 1;

/**
 * The manifest file's contents. `_generated` is the harness's DO NOT EDIT
 * header (canonical.ts) — declared optional so the exporter can parse the
 * rendered file strictly, header and all.
 */
export const ProbeManifestSchema = z.strictObject({
  manifestVersion: z.literal(PROBE_MANIFEST_VERSION),
  views: z.array(ProbeViewSchema),
  _generated: z.string().optional(),
});

export type ProbeManifest = z.infer<typeof ProbeManifestSchema>;
