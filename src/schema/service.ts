import { z } from "zod";

/**
 * A named DNS service. Two forms, told apart by `host` vs `answer` — exactly
 * one of the two is present:
 *
 * - HOST-BACKED (`host`): names a host entity; the answer is COMPUTED per
 *   view by view.ts `answerFor` (mesh view → `easytier_ip`, network view →
 *   LAN address). The probe manifest (Unit 4) derives checks from these
 *   fields: `dnsName` → dns-answer, `port` → tcp-connect, `http` →
 *   http-status.
 *
 * - STATIC ANSWER (`answer`): a literal A or CNAME value. It answers ONLY in
 *   `public`-scoped views (view.ts `answerIn`) — a public entry point has no
 *   mesh or LAN vantage to compute from, and a mesh view never borrows a
 *   public value. Static services carry no `port`/`http`: the probe manifest
 *   addresses hosts, and a CNAME has no address to probe.
 *
 * One object schema with a refine, not a union: the entity envelope is a
 * `discriminatedUnion("kind")`, and zod v4 cannot read `kind` through a plain
 * `z.union`. The refine keeps the two forms exclusive; the `transform` hands
 * TypeScript the narrowed union so renderers switch on `isHostService`.
 */

/** A literal DNS answer: the value is typed by the record type. */
export const StaticAnswerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("A"), value: z.ipv4() }),
  z.strictObject({ type: z.literal("CNAME"), value: z.hostname() }),
]);

export type StaticAnswer = z.infer<typeof StaticAnswerSchema>;

const ServiceObject = z.strictObject({
  kind: z.literal("service"),
  name: z.string().min(1),
  dnsName: z.hostname(),
  /** Host entity reference, by name. Host-backed form. */
  host: z.string().min(1).optional(),
  /** Literal answer. Static form. */
  answer: StaticAnswerSchema.optional(),
  /**
   * Declaration: this name is served in EXACTLY these views. Integrity
   * (`[service-views]`) compares the set against computed answerability and
   * refuses drift in either direction — a declared view with no answer is
   * the drop-out guard (the name must never silently promote another view's
   * answer), an answering view left undeclared is an intent update someone
   * skipped. Required once a name answers in more than one view of a single
   * resolver (`[resolver-ambiguous]`); single-view names may stay undeclared.
   */
  views: z.array(z.string().min(1)).min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  http: z
    .strictObject({
      path: z.string().startsWith("/").optional(),
      expectStatus: z.number().int().min(100).max(599).optional(),
    })
    .optional(),
  description: z.string().optional(),
});

type ServiceObject = z.infer<typeof ServiceObject>;

export type HostService = Omit<ServiceObject, "host" | "answer"> & { host: string };
export type StaticService = Omit<ServiceObject, "host" | "answer" | "port" | "http"> & {
  answer: StaticAnswer;
};
export type Service = HostService | StaticService;

export const ServiceSchema = ServiceObject.superRefine((service, ctx) => {
  const hasHost = service.host !== undefined;
  const hasAnswer = service.answer !== undefined;
  if (hasHost === hasAnswer) {
    ctx.addIssue({
      code: "custom",
      message: "a service carries exactly one of `host` (computed per view) or `answer` (static A/CNAME)",
    });
  }
  if (hasAnswer && (service.port !== undefined || service.http !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "`port` and `http` describe a host to probe; a static-answer service has none",
    });
  }
}).transform((service) => service as Service);

/** Narrowing: a service with a `host` is host-backed; otherwise it is static. */
export function isHostService(service: Service): service is HostService {
  return "host" in service && service.host !== undefined;
}
