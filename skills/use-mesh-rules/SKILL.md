---
name: use-mesh-rules
description: Use the infra-rules registry engine — setup, render commands, layout customization, the pin/upgrade model, and releases
when_to_use: Use when working with infra-rules or any repo that consumes it — rendering Surge/sing-box/probe configs from the registry, writing or editing a layout, bumping a consumer pin, upgrading after a registry or schema change, debugging an "Invalid discriminator value" refusal, or tagging an engine release. Triggers: "gen-mesh", "render-surge", "mesh rules", "infra-rules", "bump the pin", "registry render", "routerules".
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash(bun *)
  - Bash(git *)
  - Bash(just *)
  - Bash(surge-cli *)
---

# Use mesh rules (infra-rules)

infra-rules is an org-agnostic registry + rules engine (Bun + TypeScript + zod v4): one
schema for hosts, networks, meshes, views, resolvers, policies, services, routing intents,
route targets and proxy exits; renderers that turn one registry into each consumer's
config (probe manifests, sing-box dnsRules/routeRules, DNS records, Surge dconf).

Two moving parts, two speeds:

- **Engine code** — versioned; consumers pin a git tag (`bun x github:caoer/infra-rules#v0.Y.Z`).
- **Registry data** — one live head, never versioned; every consumer reads it as it changes.

## 0. Read SKILL.local.md first

`./SKILL.local.md` (gitignored) holds this machine's truth: registry path, checkout and
remotes, current tags and pins, and the consumer list with each consumer's gates and
standing orders. Read it before acting — without it you know the engine but not this fleet.

**Write-back rule:** when you learn or change a machine fact (a pin bumped, a count
changed, a new consumer, a standing order), update SKILL.local.md in the same turn, with a
dated line in its log. That file is how the next fresh agent executes well. If it is
missing, create it from the template at the bottom of this file.

This repo is **public** with a leak-guard test (`test/no-real-data.test.ts`). Real fleet
data — CIDRs, credentials, hostnames, expected counts, local paths — goes in
SKILL.local.md only, never in committed files.

## Commands

From a consumer: `bun x github:caoer/infra-rules#<tag> <command>`. In the engine checkout:
`bun run src/cli.ts <command>` (dev setup: `bun install`; gates: `bun test`,
`bun run typecheck`).

- `validate <registry.json>` — report every violation. Exit 0 valid, 1 violations, 2 usage.
- `render --registry <file> --out <dir> [--produced <file>|-] [--views a,b]` — write
  artifacts. `--views` is REQUIRED when `--out` is a per-org repo.
- `diff --registry <file> --out <dir> [--views a,b]` — compare without writing.
  Exit 0 same, 1 differ, 2 failed.
- `render-surge --registry <file> --layout <file> --out <file>` — Surge dconf to one
  explicit file. Deliberately not part of `render`: the artifact carries proxy credentials.

Every command refuses loudly and writes nothing on a parse or validation error — a failed
run never corrupts the artifact on disk.

## The pin model — what protects against what

A tag pin freezes engine *code*: renders stay reproducible, and a bad release cannot reach
you until you bump. It does NOT protect against registry *data* moving: the schema parses
strictly (discriminated union on `kind`, strict envelope), so an entity kind added to the
registry is a hard parse error for every older pin. Additive data change = breaking read.

This is by design. A routing renderer that skipped unknown kinds would render a profile
silently missing rules — wrong routing, no signal. Loud refusal is the safe failure.

**Consequence — registry and engine move together.** Publishing registry data that uses a
new kind is a fleet event, in this order:

1. Release the engine (tag, push to all remotes).
2. Bump every consumer pin; re-verify each render.
3. Only then publish the registry data.

## Upgrade a consumer

1. Bump the engine tag in the consumer's recipe (justfile or equivalent).
2. Apply any layout changes the new version requires — retired keys refuse, new required
   keys must appear.
3. Render. Compare the stderr summary counts against the expected line in SKILL.local.md —
   **any unexpected count is a stop**, not a warning.
4. Diff the generated artifact, run the consumer's own gate, then build/deploy per that
   consumer's rules in SKILL.local.md.

**Success criteria**: render exits 0; counts match; the consumer gate passes;
SKILL.local.md carries the new pin (and new counts only if the delta is proven intended).

## Customize, consumer side: the layout

`render-surge` takes a layout JSON kept in the consumer repo — the consumer's own
declaration: region order, jumpers, spares, proxy extras, host suffix, policy-group names,
pin policy, and `memberOf`.

Per-exit shape lives on the `proxyExit` entity, not the layout (v0.12.0): `shadowTls:
{password, sni, version: 3}` emits `shadow-tls-password/-sni/-version` after the
password; `extras: ["udp-relay=true", …]` replaces the layout-wide `proxyExtras` for that
exit (`[]` = no extras — a shadow-tls exit is TCP-only). A `password` may be a consumer
template (`${SERVER_PSK}:${USER_PSK}`) — the engine renders it verbatim, the consumer
substitutes after the render; the engine never reads secrets.

`memberOf` is the mesh-membership ruling and is required: **membership is data, never
inferred from addresses.** A member of a mesh routes that mesh's space over its own path;
a non-member detours through proxy groups. `"memberOf": {}` is a valid, explicit answer —
member of nothing, every mesh range detours. Same registry, different targets, different
correct answers, decided only by this declaration.

## Customize, engine side: new kinds and renderers

Schema lives in `src/schema/` (one file per kind, wired into `EntitySchema` in
`src/schema/registry.ts`); renderers live in `src/render/`. Adding a kind is engine
development: strict parsing makes it break every older pin the moment data uses it, so it
requires a release plus fleet-wide pin bumps — follow the fleet-event order above.
`SCHEMA_VERSION` guards only envelope shape; it does not signal new kinds.

## Release (maintainer)

1. Green gates in the engine checkout: `bun test` and `bun run typecheck`.
2. Annotated tag on the exact verified sha: `git tag -a v0.Y.Z <sha> -m "<what changed>"`.
3. Push the tag to **every remote, by name** (`git remote -v`; the list lives in
   SKILL.local.md). Never bare `origin` — a tag on one forge strands consumers on the other.
4. Verify with grep, never tail: `git ls-remote --tags <remote> | grep v0.Y.Z`. Tag
   listings sort lexicographically — `v0.10.0` hides between `v0.1.x` and `v0.2.0`.
   Locally use `git tag --sort=version:refname`.

**Success criteria**: the tag resolves on every remote and points at the verified sha.

## Troubleshooting

- `Invalid discriminator value. Expected 'host' | ...` at some `hand[N].kind` — the
  registry holds an entity kind newer than your pin. Not corruption; nothing was written.
  Fix: run "Upgrade a consumer".
- A layout key refused — the layout must move with the engine version; fix in upgrade
  step 2.
- Unexpected stderr counts — stop. Diff the artifact, find the delta's source, and update
  the expected line in SKILL.local.md only after proving the delta intended.

## SKILL.local.md template

```
# use-mesh-rules — machine-local truth (gitignored)

## This machine
- Engine checkout: <path>
- Remotes (push tags to ALL, by name): <name> <url> · <name> <url>
- Registry live head: <path>
- Latest engine tag: <tag> = <sha> (<date>)

## Consumers
### <name>
- Standing orders: <who may edit what>
- Repo: <path> · Recipe: <command>
- Current pin: <tag> · Gate: <command and pass condition>
- Expected render counts: <line> — any other counts are a stop

## Write-back log
- <date> <agent>: <fact learned or changed>
```
