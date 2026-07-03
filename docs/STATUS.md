# Engram — Project Status Report

**Date:** 2026-07-03
**Version:** 0.5.4 · **Head:** `7c03cb7`
**Repo:** https://github.com/kooroot/Engram · **npm:** [@kooroot/engram](https://www.npmjs.com/package/@kooroot/engram) (latest 0.5.4)

---

## Executive Summary

Engram has progressed from an initial MCP prototype to a **published, production-ready AI-native memory infrastructure**. Beyond the multi-tenant core (event log + state tree + vectors, exposed over MCP / CLI / REST), the system now **captures memory automatically** — via onboarding instructions, Claude Code / Codex / Gemini hooks, and **Twin Mode** transcript extraction — and keeps the graph clean with **write-time + retroactive dedup**.

**Maturity rating:** Published to npm as `@kooroot/engram` (latest **0.5.4**). Runs daily as the shared memory backend for multiple AI CLIs. The most recent cycle (0.5.4) was a correctness + performance pass — mutation/event-log atomicity, idempotent maintenance, an archive grace window, and 5–46× write/dedup speedups.

---

## Timeline — pre-1.0 build-out (all bundled into the v0.1.0 tag)

```
Phase 0 — Greenfield (2026-04-12 → 2026-04-13)
  feece7e  feat: implement Engram — AI-native persistent memory MCP server
  c54b138  fix: address all code review findings (C1-C3, H1-H5, M1-M7, L1-L6)
  8b1076b  docs: rewrite README with architecture diagrams

Phase 1 — Multi-interface layer (2026-04-13)
  d83ec17  feat: add CLI layer with service abstraction
  768bfff  feat: add REST API with Hono + engram serve command
  22e574c  docs: add CLI and REST API usage sections to README
  1147269  fix: address v2 review findings (H1-H3, M1-M7, L1/L5/L6)
  de8cced  fix: bugs found during E2E verification + async callback drain

Stage A — Run-ready (2026-04-13 → 2026-04-14)
  34b0d97  feat: add namespace isolation (multi-tenant memory)
  1ccbdfd  feat: FTS5 full-text keyword search (10x+ faster at scale)
  9959519  feat: JSON import/export per namespace
  4ab47fa  feat: merge_nodes — unify duplicate entities

Stage B — Production-ready (2026-04-14)
  ceec1d3  feat: observability — Prometheus metrics + structured logging
  6b266a8  feat: rate limiting for REST API (token bucket)
  83aa194  feat: REST auth (Bearer token) + docs for Stage B

Stage X — Adversarial review fixes (2026-04-14)
  f1d057e  fix: critical namespace isolation flaws (C-A1, C-A2, C-A3, H-A4)
  e917739  fix: rate limit XFF trust + token key collision (C-B1, H-B4)
  e5cbbb4  fix: DoS defenses — bounded core cache + metric cardinality cap (H-B2, H-B3)
  c72f8dd  fix: auth observability + hardening (H-B1, M4, M5)
  3cc3d74  fix: attach event_id to history by rowid (M8)
  ae440a7  fix: medium hardening — schema, NaN, batch embed, body limits (M1, M3, M6, M7, M11)
```

---

## Release History (published to npm)

The build-out above shipped as **v0.1.0**. Subsequent published releases:

| Version | Date | Headline |
|---------|------|----------|
| **0.1.x** | 2026-04-14/15 | Onboarding polish — TUI wizard, `doctor --fix`, native Ollama provider, `engram.env` auto-load, one-pass Claude/Codex/Gemini registration + instruction install |
| **0.2.x** | 2026-04-15 | Per-tool token-usage tracking + `engram usage`, heatmap view |
| **0.3.x** | 2026-04-15 | `engram tui` dashboard (ink + React); `reset` / `backup` / `restore`; flat single-op tool payloads (Gemini compat); proactive-capture instructions |
| **0.4.0** | 2026-04-16 | Claude Code hooks — auto-capture as a hard mechanism |
| **0.5.0** | 2026-04-20 | **Twin Mode** — cross-AI memory via transcript extraction (Anthropic / Claude / Codex / Gemini providers + hook adapters) |
| **0.5.1** | 2026-04-20 | Auto-dedup on `mutate_state`; `maintenance --dedup` retroactive cleanup |
| **0.5.2** | 2026-05-20 | Codex `[features].hooks` flag fix |
| **0.5.3** | 2026-06-15 | `maintenance --compact-history` retention pruning |
| **0.5.4** | 2026-07-03 | **P-series** correctness + performance: atomic mutation+event, idempotent decay, archive grace window, `reembed`; **5–46× write/dedup, ~2.7× hook cold-start** |

See [CHANGELOG.md](../CHANGELOG.md) for full per-version detail.

---

## Current Shape

### Code metrics

| Dimension | Value |
|-----------|-------|
| Source files | 61 TypeScript/TSX + 12 SQL migrations |
| Lines of source | ~12,300 |
| Tests | **249 passing** (19 files) |
| MCP tools | **7** |
| REST endpoints | **14** documented (incl. health / metrics) |
| CLI commands | **25** |
| External runtime deps | `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `hono`, `@hono/node-server`, `chalk`, `commander`, `ulid`, `zod`, `ink`, `react`, `@clack/prompts`, `@anthropic-ai/sdk` |

### Tech stack

- **Language:** TypeScript (strict mode), ESM only
- **Runtime:** Node.js ≥ 20 (bun for package management + scripts)
- **Databases:** SQLite (WAL mode, two files) with sqlite-vec extension
- **HTTP:** Hono + `@hono/node-server`
- **MCP:** Official TypeScript SDK (stdio transport)

### Access surface

```
┌─────────────────────┐
│ AI agents (Claude,  │───┐
│ Cursor, custom)     │   │ MCP / stdio
└─────────────────────┘   │
                          ▼
┌─────────────────────┐   ┌──────────────────────────┐
│ Humans, terminals   │──▶│   service.ts (shared)    │
└─────────────────────┘   │                           │
       │ CLI              │   graph + vector store   │
       ▼                  │   + auth + rate + metrics│
┌─────────────────────┐   │                           │
│ Web apps, scrapers, │──▶│                           │
│ dashboards          │   └──────────────────────────┘
└─────────────────────┘       REST / HTTP
```

---

## Feature Maturity

| Area | Maturity | Notes |
|------|----------|-------|
| 3-tier memory (Event Log / State Tree / Vectors) | ✅ Stable | per-namespace checksum chain, atomic mutation + event append |
| MCP tools | ✅ Stable | 7 tools, Zod-validated, cache-invalidating |
| CLI | ✅ Stable | 25 commands, colorized output |
| REST API | ✅ Stable | 14 endpoints, auth + rate + CORS + body limits |
| Namespaces | ✅ Stable | Per-row scoping, LRU core cache, allowlist |
| FTS5 keyword search | ✅ Stable | Auto-synced via triggers, sub-1 ms at 11 K nodes |
| Semantic search | ✅ Functional | OpenAI + local providers, auto-embed on mutation (batched) |
| JSON import/export | ✅ Functional | 4 strategies; `merge` strategy is replace-if-newer (M2 follow-up) |
| merge_nodes | ✅ Stable | Re-points edges, snapshots to history, dedupes |
| Observability | ✅ Functional | Prometheus metrics, structured logs, X-Request-ID |
| Rate limiting | ✅ Stable | Token bucket, socket-addr default, XFF opt-in |
| Authentication | ✅ Stable | Bearer token, timing-safe compare, multi-token rotation |
| Production hardening | ✅ Stable | Body limits, input caps, NaN-safe env parsing |
| Onboarding (`onboard` / `doctor`) | ✅ Stable | TUI wizard, one-pass Claude/Codex/Gemini registration, `doctor --fix` |
| Auto-capture hooks | ✅ Stable | Claude Code / Codex / Gemini session hooks (v0.4.0, v0.5.2 flag fix) |
| Twin Mode (`autosave`) | ✅ Functional | Transcript → structured memory; Anthropic / Claude / Codex / Gemini providers (v0.5.0) |
| Deduplication | ✅ Stable | Auto-dedup on `mutate_state` create + `maintenance --dedup` retroactive (v0.5.1) |
| History compaction | ✅ Stable | `maintenance --compact-history` retention pruning (v0.5.3) |
| TUI dashboard (`usage`) | ✅ Stable | ink + React; graph, events, per-tool token heatmap (v0.2–0.3) |
| Write/read performance | ✅ Stable | Atomic mutation+event; P7 pass = 5–46× write/dedup, ~2.7× hook cold-start (v0.5.4) |

---

## Security Posture

Adversarial review was applied twice. Current mitigations:

| Attack Surface | Mitigation |
|----------------|------------|
| Cross-namespace data destruction via import | Pre-check blocks writes to node IDs belonging to another namespace |
| Edge triplet global collision | Unique index includes namespace (migration 008) |
| Cross-namespace ghost edges | `link_entities` validates source/target exist in caller's namespace |
| X-Forwarded-For rate-limit bypass | `ENGRAM_TRUST_PROXY` gate, default uses socket address |
| Token fingerprint collision | SHA-256 of full token, 16 hex chars |
| Timing attack on token compare | `crypto.timingSafeEqual` on equal-length buffers |
| Empty-token silent auth bypass | Startup WARN log if env var set but no valid token parsed |
| Metric cardinality explosion (malicious namespaces) | `ENGRAM_METRIC_NAMESPACES` allowlist, unknown → `_other` |
| Core cache unbounded (FD exhaustion) | LRU eviction with `core.close()`, cap via `ENGRAM_CORE_CACHE_SIZE` |
| Namespace flooding | `ENGRAM_NAMESPACE_ALLOWLIST` rejects unknown namespaces at the REST boundary |
| Large body DoS | `ENGRAM_CONTEXT_MAX_BYTES` / `ENGRAM_IMPORT_MAX_BYTES` via Hono body-limit |
| Malformed import payload | Zod bundle schema with per-array 100K cap |
| NaN env var locking rate limit | `envInt()` falls back to default on non-positive / non-finite |
| Auth failure invisibility | `engram_auth_failures_total{reason}` + WARN log per failure |
| History cascade on node delete | FK `ON DELETE CASCADE` removed (migration 008) — audit survives delete |
| Over-broad `changed_by IS NULL` update | History rowid tracked per insert, UPDATE by exact id |

**H-A3 resolved (0.5.4):** `mutate` / `link` / `mergeNodes` now append the event log *inside* the mutation transaction (commit `0fa4b3b`; P6b `313841b` promoted the append to `BEGIN IMMEDIATE`), so state, event, and their linkage commit atomically. `verifyIntegrity()` continues to validate the per-namespace chain.

---

## Performance

| Workload | Target | Measured |
|----------|--------|----------|
| FTS5 keyword search at 100 nodes | < 1 ms | 0.07 ms |
| FTS5 keyword search at 1.1 K nodes | < 5 ms | 0.15 ms |
| FTS5 keyword search at 11 K nodes | < 10 ms | 0.88 ms |
| Mutation batch (50 ops) | < 50 ms | ~20 ms single txn |
| `get_context` hybrid (graph + semantic) | < 200 ms | ~80 ms for 8 nodes + embed call |
| Namespace creation (first touch) | N/A | Opens 2 SQLite handles, runs migrations once per process |

The 0.5.4 **P7 pass** added a measured hotpath benchmark (`bun run bench` → `scripts/bench-perf.ts`) across the write path, FTS, dedup, and CLI cold-start, yielding **5–46× write/dedup speedups** and **~2.7× faster hook cold-start**. Mutation and event-log append are now committed in a single transaction (previously the deferred H-A3 risk).

---

## What's Intentionally Deferred

| Item | Why deferred |
|------|--------------|
| **M2** import `merge` strategy actually merges properties | Current behavior is "replace if newer," which is usable; deeper merge matches `StateTree.mergeNodes` semantics |
| **M9** FTS5 sanitizer handles hyphenated tokens | Minor UX; quoted phrases work today as a workaround |
| **M10** REST error handler uses string matching | Works today; brittle on future error messages. Error classes coming in Stage C |
| **Web dashboard** | REST API is ready; UI is a separate project |
| **Per-tool MCP rate limiting** | MCP SDK lacks middleware; wrap-per-tool is doable but not urgent |
| **Snapshots / fork / undo** | Listed in long-term enhancements |
| **Schema validation per node type** | Listed in long-term enhancements |

These are tracked in `docs/STATUS.md` (this file) and in the review artifacts in the repo history.

---

## What's Next

### Immediate (recommended)

1. ✅ **Dogfooded** — runs daily as the shared memory backend across multiple AI CLIs (Twin Mode + auto-capture hooks).
2. ✅ **npm published** — `@kooroot/engram` on npm (latest 0.5.4); `npx @kooroot/engram …` works for zero-install agents.
3. **CI/CD** (still open): GitHub Actions with typecheck + test + build on PR — no `.github/workflows` yet.

### Stage C (when quality-tier improvements become worthwhile)

- Recursive CTE traversal (perf at depth ≥ 3)
- Edge embeddings (semantic quality)
- Time-travel queries via `node_history`
- Web dashboard (graph visualizer + event timeline)
- Plugin hook system (audit exporter, webhook)

---

## Deployment Readiness Checklist

| Item | Status |
|------|--------|
| TypeScript strict mode, zero errors | ✅ |
| All tests pass | ✅ 249/249 |
| Schema migrations version-tracked | ✅ `_migrations` table |
| Auth, rate limit, CORS, body limits | ✅ All env-configurable |
| Prometheus metrics + health endpoint | ✅ `/api/metrics`, `/api/health` |
| Structured logs with request IDs | ✅ JSON logger to stderr |
| Multi-tenant isolation | ✅ Namespaces with hard isolation |
| Graceful shutdown (HTTP + SQLite) | ✅ SIGINT / SIGTERM |
| Backup / restore path | ✅ JSON export/import |
| `.env.example` documenting all env vars | ✅ |
| Architecture + operations docs in README | ✅ Rewritten 2026-04-14 |
| npm package published | ✅ `@kooroot/engram` (latest 0.5.4) |
| CI/CD pipeline | ❌ Not yet wired (no `.github/workflows`) |
| Observability dashboards pre-built | ❌ Raw metrics only |

---

## Summary

Engram went from "prototype" to "production-hardened multi-tenant memory infrastructure" over ~20 commits. The system has been reviewed adversarially twice and the critical findings are all resolved. The remaining deferred items are documented and non-blocking.

If the goal is "ship internal," it's shippable now. If the goal is "public product," the remaining work is packaging (npm, CI, a dashboard), not functionality.
