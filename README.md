# infra-rules

Org-agnostic infrastructure registry + rules engine. Bun + TypeScript + zod v4.

One schema for hosts, networks, meshes, views, resolvers, policies, services, routing
intents, route targets and proxy exits; renderers that turn that registry into the config
each consumer needs (probe manifests, sing-box `dnsRules` and `routeRules`, DNS records,
Surge dconf) and a probe exporter that pushes reachability metrics to VictoriaMetrics.

Routing intents stay abstract in the registry (range → policy). Each render target
declares its mesh membership explicitly — a member routes a mesh's space over its own
path into that overlay; a non-member detours through proxy groups. Membership is data,
never inferred from addresses.

## Status

v0 — under construction. Consumers pin a tag: `bun add github:caoer/infra-rules#v0.Y.Z`.

## Repo discipline

This repository is **public**. It contains **no real fleet data**: no live CIDRs, no
credentials, no exit IPs. A leak-guard test (`test/no-real-data.test.ts`) enforces that
mechanically over `fixtures/`, `test/golden/`, `src/` and this README — an address
outside the synthetic bands fails the suite wherever it is written, comments included.
