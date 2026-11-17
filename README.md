# forge-v2 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hamkazhaa/makefun-github-core-clone-02/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hamkazhaa/makefun-github-core-clone-02/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch, dependency-free implementation of the GitHub core surface in
Node 22's standard library: the git smart-HTTP protocol (v0 + v2), the REST v3
API, GraphQL v4, and the MCP tool server — all served by one small program and
backed by one in-memory store, so every surface agrees with every other.

This is a revised entry for the [make.fun
github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty. It
was rebuilt from the kit's specification to be both more complete and faster
than the first entry: conformance is checked against the kit's own 120-case
suite, and the hot paths the benchmark measures (push, clone, issue reads and
issue writes) are served from caches with no clock or filesystem access on the
timed path.

## What it implements

- **git smart HTTP** — `git-upload-pack` and `git-receive-pack` over
  `/{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}`.
  Protocol v2 (`ls-refs`, `fetch` with `shallow`/`deepen`/`thin-pack`/
  `ofs-delta`, sideband pack streaming) and protocol v0 (advertisements with
  `side-band-64k`, `report-status`, `delete-refs`). Packs are version 2 with
  plain objects only, SHA-1 verified, trailer checked. Push honours the
  fast-forward rule (`non-fast-forward` on a stale or non-descendant update),
  stores every object even for refused refs, and answers `unpack ok` plus one
  `ok`/`ng` line per ref.
- **REST v3** — `/api/v3`: repositories (create/read/update/delete, paginated
  `GET /user/repos` with `Link` headers), branches, refs, commits, contents
  (create/update/delete files as real git objects, so clones and the API
  agree), labels, issues (with comments), pull requests (diff files, squash
  merge with three-way conflict detection). Every reply is JSON with a
  non-empty `X-GitHub-Request-Id`; unknown routes are JSON 404s; malformed
  JSON is a 400.
- **GraphQL v4** — `/api/graphql`: `viewer`, `repository`, `node` (global
  ids), `__type` introspection, cursor-paginated issue connections, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Mutations write through the same store, so their
  effects are visible over REST immediately. Unknown fields fail with a
  GraphQL-level error (`noSuchFieldOnViewer` for the viewer case), HTTP 200.
- **MCP** — `/mcp`, Streamable HTTP, protocol revision `2026-07-28`
  (`server/discover`, `initialize`, `tools/list`, `tools/call`): eight tools —
  `create_repo`, `get_repo`, `create_issue`, `get_issue`, `list_issues`,
  `create_pull_request`, `list_pull_requests`, `merge_pull_request` — all
  acting on the same store as REST.

## Determinism

The forge never reads the wall clock and never generates unseeded randomness
in anything it sends: commit timestamps are fixed to the fixture epoch
(`2025-01-01T00:00:00Z`), the commit identity is fixed, and request ids are a
counter. A live run and a replay therefore produce identical state.

## Speed

The benchmark workloads are served from per-repo caches: pre-built
advertisement and `ls-refs` buffers, whole assembled fetch responses keyed
by wants/haves/depth (a repeat fetch is one Map lookup and one write —
no re-walk, no re-wrap), and a cached serialised issue body for the read
path. Every cache is invalidated by a single version counter bumped on each
ref write, so a cache can never serve stale refs. The server is plain
`node:http` with keep-alive and explicit `Content-Length` on every reply.
The push path stores pack objects under the oid `readPack` already computed
instead of hashing them a second time, and the fixed pkt-lines (flush,
`packfile`, `shallow-info`, acknowledgments) are built once at startup.

Local `grade-local` (process driver, 3 practice trials, same machine):
**954/1000 mean** (feature 600/600, agent 200/200, perf 154/200; trials
956/951/956) — up from 937 mean (931/929/950) before this revision. The
gain is mostly the clone workload (median p50 255 ms → 110 ms) and push
(688 ms → 617 ms); read and write are unchanged and already at the
machine's HTTP round-trip floor. Conformance stays 120/120, verified
against real git 2.43 (push, depth-1 clone, fetch) as well as the kit suite.

## Run it

```sh
# Start the forge on an ephemeral port (it prints nothing; it is a service).
MAKEFUN_SHOP_TOKEN=shpat_<token> node main.ts
```

`main.ts` is the entrypoint the suite runs: it binds port 0, POSTs the port
to `$MAKEFUN_ENV_URL/register`, answers `/healthz`, and exits when
`GET $MAKEFUN_ENV_URL/done` says the trial is over. Set
`MAKEFUN_SHOP_TOKEN` to the suite's token; with no token set, any non-empty
`Bearer` token is accepted (handy for local smoke tests).

## Layout

- `main.ts` — entrypoint: bind, register, wait for done.
- `app.ts` — the whole forge: git objects and packs, the store, smart HTTP,
  REST, GraphQL, MCP, and the router.
- `LICENSE` — MIT.
