import { z } from "zod";

/**
 * A named service on a host. The probe manifest (Unit 4) derives checks from
 * these fields: `dnsName` → dns-answer check (expected IP computed per view),
 * `port` → tcp-connect check, `http` present → http-status check.
 */
export const ServiceSchema = z.strictObject({
  kind: z.literal("service"),
  name: z.string().min(1),
  dnsName: z.hostname(),
  /** Host entity reference, by name. */
  host: z.string().min(1),
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

export type Service = z.infer<typeof ServiceSchema>;
