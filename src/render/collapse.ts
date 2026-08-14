/**
 * The empty-render guard, shared by every view-scoped renderer.
 *
 * `surge.ts` refuses an empty selection because "empty output is
 * indistinguishable from correct output until someone diffs it against
 * reality". The same is true of `{"dnsRules": []}`, `{"records": []}` and a
 * manifest of empty check lists: nix builds them clean, the gateway starts,
 * and the names simply stop resolving.
 *
 * What it cannot be is a blanket per-file refusal. An empty file is a
 * LEGITIMATE value — hq-lan has no service answering in its vantage, and that
 * emptiness is the true statement. The distinguishable failure is the
 * COLLAPSE: the registry still declares services and views, and the renderer
 * produced nothing for any of them. One view answering nothing is data; every
 * view answering nothing, with services on the books, is a broken export.
 */

/** Refuses a whole-render collapse: inputs present, output empty everywhere. */
export function assertNotCollapsed(options: {
  renderer: string;
  services: number;
  views: number;
  emitted: number;
  unit: string;
}): void {
  const { renderer, services, views, emitted, unit } = options;
  if (services === 0 || views === 0 || emitted > 0) return;
  throw new Error(
    `renderer "${renderer}": ${services} service(s) and ${views} view(s) in the registry ` +
      `produced 0 ${unit} across every view — an empty render is byte-identical to a correct ` +
      `one, so it is refused rather than written. Either the export lost its host addresses ` +
      `or the view scopes no longer match them; run validate and diff the registry`,
  );
}
