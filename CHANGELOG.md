# Changelog

All notable changes to **Engram** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] — 2026-07-03

Correctness + performance release (the "P-series" pass). No breaking changes.

### Added
- **`engram reembed`** — CLI command to backfill or refresh node vectors after
  changing embedding provider/model or importing legacy data (P4-3).
- OpenAI embedding provider now applies a request **timeout + bounded retry**
  instead of hanging on a slow/stuck API call (P4-2).

### Performance
- **P7 hotpath pass** (measured): **5–46× faster** write/dedup paths and
  **~2.7× faster** hook cold-start, across the write path, FTS, dedup, and CLI
  startup.
- Read path: `get_context` expansion is now **batched** with a per-type cap
  applied on the MCP path, cutting query fan-out.
- DB: SQLite **planner statistics + PRAGMA tuning**, and redundant indexes
  dropped (P3).
- Embeddings: **skip re-embedding** when a node's embed-input is unchanged
  (P4-1).
- Maintenance: history compaction is **pre-filtered to over-cap nodes** so the
  pass scales with work to do, not total node count (P5).
- Removed a dead in-memory node-cache surface (refactor Step 0).

### Fixed
- **Mutation + event-log append are now atomic** — a node write and its event
  are committed in a single transaction (state-tree).
- Confidence **decay is now idempotent** — re-running maintenance no longer
  compounds decay (P5).
- Read path: **don't drop nodes on token-budget overflow**, and cap edges per
  node so one hub node can't crowd out the context (P6a).
- Event append now takes a **write-lock**, and `merge_nodes` collapses
  self-loop edges instead of persisting them (P6b).
- Maintenance applies a **grace window** before archiving freshly-created
  low-confidence nodes, so new memories aren't reaped prematurely (P6c).

## [0.5.3] — 2026-06-15

### Added
- **`engram maintenance --compact-history`** — retention-based pruning of the
  `node_history` table, keeping recent versions per node while bounding growth
  of the history tier. Supports `--dry-run` preview.

## [0.5.2] — 2026-05-20

### Fixed
- **Codex hook registration** now uses the current `[features].hooks` config
  key. The previous `[features].codex_hooks` key is deprecated and produced a
  warning on Codex startup.

## [0.5.1] — 2026-04-20

Deduplication release (Phases 6a–6c).

### Added
- **Auto-dedup on `mutate_state` create (Tier 1)** — near-duplicate nodes are
  detected and collapsed at write time instead of accumulating.
- **`engram maintenance --dedup`** — retroactive cleanup pass that merges
  existing duplicate nodes across a namespace (Phase 6b).

### Fixed
- Dedup correctness: **token-subset matching**, **intra-batch dedup** (duplicates
  within a single mutation batch), and an **event audit trail** for every merge.

## [0.5.0] — 2026-04-20

**Twin Mode — cross-AI persistent memory.** Engram can now extract structured
memories directly from AI conversation transcripts, so any assistant's session
feeds the same graph.

### Added
- **`engram autosave`** — orchestrator that reads a conversation transcript and
  extracts structured memories against a dedicated extraction schema, with
  same-name dedup within each batch.
- **Provider backends** for extraction:
  - **Anthropic SDK** provider.
  - **Claude CLI** provider (uses your subscription auth — no API key required).
  - **Codex CLI** and **Gemini CLI** providers (stdin transcript transport).
- **Hook adapters** for Claude Code, Codex, and Gemini so autosave can fire
  automatically at end-of-turn / session events.
- `--hook-format` flag and provider + hook validation on the CLI.

### Security
- API keys are **scrubbed** from transcripts before extraction; transcript is
  passed over stdin; extraction JSON schema tightened per adversarial review.

## [0.4.0] — 2026-04-16

### Added
- **Claude Code hooks for auto-capture** — a "hard" mechanism that captures work
  automatically via the hook system, rather than relying on prompt instructions
  alone.

## [0.3.8] — 2026-04-15

### Changed
- More aggressive agent instructions: the assistant proactively auto-captures
  any substantive work without being asked.

## [0.3.7] — 2026-04-15

### Added
- **`engram backup` / `engram backups` / `engram restore`** commands.
- Safer `engram reset` with an interactive backup prompt before wiping.

## [0.3.6] — 2026-04-15

### Added
- **`engram reset`** — wipe a namespace's data with an optional backup.

## [0.3.5] — 2026-04-15

### Fixed
- `mutate_state` / `link_entities` accept a **flat single-op** payload and
  tolerate extra fields — Gemini function-calling compatibility.

## [0.3.4] — 2026-04-15

### Changed
- Agent instructions: proactive capture guidance and **cwd-anchored project**
  detection.

## [0.3.3] — 2026-04-15

### Fixed
- TUI navigates with **arrow keys only**; the focus model is unified across all
  tabs.

## [0.3.2] — 2026-04-15

### Fixed
- TUI: `esc` also quits; browse detail uses enter/backspace to go back.

## [0.3.1] — 2026-04-15

### Changed
- `engram usage` **is** the TUI dashboard; `engram tui` kept as a hidden alias;
  arrow keys navigate tabs.

## [0.3.0] — 2026-04-15

### Added
- **`engram tui`** — interactive multi-tab dashboard (ink + React).

## [0.2.1] — 2026-04-15

### Added
- Visual **heatmap** usage view.

### Fixed
- `engram doctor` Gemini check now handles JSONC settings files.

## [0.2.0] — 2026-04-15

### Added
- **Per-tool token usage tracking** and the **`engram usage`** CLI.

## [0.1.9] — 2026-04-15

### Added
- `engram onboard` installs **token-conscious Engram instructions** into each
  detected AI CLI.

## [0.1.8] — 2026-04-15

### Added
- One-pass onboarding: register Engram with **Claude, Codex, and Gemini** in a
  single `engram onboard` run.

## [0.1.7] — 2026-04-15

### Fixed
- `engram onboard` surfaces **stale shell env vars** that would otherwise
  override the saved config.

## [0.1.6] — 2026-04-15

### Added
- Auto-load `engram.env` so users don't have to `source` it manually.

## [0.1.5] — 2026-04-15

### Added
- Native **Ollama** embedding provider; `engram onboard` **live-tests** the
  chosen provider before saving.

## [0.1.4] — 2026-04-14

### Fixed
- `engram doctor --fix` now rebuilds the **actually-hoisted** native module.

## [0.1.3] — 2026-04-14

### Added
- Rainbow banner and **`engram doctor --fix`** auto-repair.

## [0.1.2] — 2026-04-14

### Fixed
- `bun install` hydrates native modules; richer onboard guidance.

## [0.1.1] — 2026-04-14

### Added
- Onboarding TUI via `@clack/prompts` — arrow-key navigation + spinners.

## [0.1.0] — 2026-04-14

Initial public release — the full AI-native persistent-memory server.

### Added
- **Three-tier memory architecture:**
  - **Event Log** — append-only, with a per-namespace SHA-256 checksum chain.
  - **Cognitive State Tree** — nodes + SPO-triplet edges, FTS5-indexed.
  - **Vector Store** — sqlite-vec KNN over auto-generated embeddings.
- **7 MCP tools:** `mutate_state`, `link_entities`, `query_engram`,
  `get_context`, `search_memory`, `log_event`, `merge_nodes` — Zod-validated,
  cache-invalidating.
- **CLI** over a shared service layer: `status`, `nodes`, `node`, `edges`,
  `search`, `events`, `history`, `context`, `maintenance`, `namespaces`,
  `merge`, `export`, `import`, `serve`.
- **REST API** (Hono) via `engram serve` — 14 endpoints with Bearer-token auth,
  token-bucket rate limiting, CORS, and per-endpoint body limits.
- **Namespace isolation** (multi-tenant memory) with an LRU core cache and an
  optional allowlist.
- **FTS5 full-text keyword search** — ~10× faster than `LIKE` scans at scale
  (sub-millisecond at 11K nodes).
- **JSON import/export** per namespace and **`merge_nodes`** duplicate
  unification (re-points edges, archives source).
- **Observability:** Prometheus metrics, structured JSON logging, and
  `X-Request-ID` correlation.
- **`engram onboard`** interactive wizard and **`engram doctor`** verification;
  shell embedding provider; npm publish preparation.

### Security
- Two rounds of adversarial-review hardening: namespace-isolation fixes,
  `X-Forwarded-For` trust gate, metric-cardinality cap, bounded core cache,
  request body limits, timing-safe token comparison, and NaN-safe env parsing.

[0.5.4]: https://github.com/kooroot/Engram/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/kooroot/Engram/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/kooroot/Engram/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/kooroot/Engram/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/kooroot/Engram/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kooroot/Engram/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/kooroot/Engram/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/kooroot/Engram/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/kooroot/Engram/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/kooroot/Engram/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/kooroot/Engram/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/kooroot/Engram/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/kooroot/Engram/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/kooroot/Engram/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kooroot/Engram/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/kooroot/Engram/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kooroot/Engram/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/kooroot/Engram/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/kooroot/Engram/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/kooroot/Engram/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/kooroot/Engram/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/kooroot/Engram/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kooroot/Engram/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kooroot/Engram/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kooroot/Engram/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kooroot/Engram/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kooroot/Engram/releases/tag/v0.1.0
