# Engram Twin Mode — Design

**Date:** 2026-04-20
**Status:** Design (decisions locked, no code yet)
**Goal:** Make Engram act as a true cross-AI "분신" — one persistent identity across Claude Code, Codex CLI, and Gemini CLI sessions.

---

## 1. Why this exists

Today Engram only injects context **once at session start** (via `session-start.mjs` hook calling `engram context <project>`). Every subsequent turn the model has to remember to call `get_context` itself, and the user has to trust it to call `mutate_state` when something substantive happens. Both fail silently.

Twin Mode closes both gaps:
1. **Per-turn auto-injection** — every user prompt triggers a relevant-context fetch.
2. **Post-session auto-save** — at session end, a small LLM extracts anything substantive the working model forgot to save.

And it does both across **all three CLI AIs**, so the same identity follows the user wherever they work.

---

## 2. Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Cross-AI scope = Claude Code + Codex CLI + Gemini CLI | Web AIs deferred per "no hosting/tunneling yet" memory rule |
| 2 | Shared kernel in engram core, thin per-AI adapters | One implementation, three 30-line hook scripts |
| 3 | Auto-save = Stop hook batch (not per-turn LLM) | 5–10× more token-efficient; sees full session arc, filters noise/reversals automatically |
| 4 | Auto-save provider = host AI's light model by default, single-provider override via config | 5–15× cheaper than fixed Haiku; reuses already-configured API keys |
| 5 | Output schema fixed on engram side | Provider-agnostic storage even with mixed models |
| 6 | Single-machine SQLite for now | Multi-machine sync deferred (no hosting) |

---

## 3. High-level architecture

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Claude Code    │  │   Codex CLI     │  │   Gemini CLI    │
│  (host AI)      │  │   (host AI)     │  │   (host AI)     │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │ hooks              │ hooks              │ hooks
         ▼                    ▼                    ▼
┌────────────────────────────────────────────────────────────┐
│  Per-AI adapter (~30 LOC each, ~/.engram/hooks/<ai>/)      │
│   • on user prompt → call `engram context`                 │
│   • on session stop → call `engram autosave`               │
└──────────────────────────┬─────────────────────────────────┘
                           │ shell exec (stdin/stdout JSON)
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Engram CLI (shared kernel, src/cli/)                      │
│   • `engram context <prompt>`        → JSON for injection  │
│   • `engram autosave <transcript>`   → mutate_state batch  │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
                  ~/.engram/engram.db (SQLite)
```

**Key separation:**
- **Adapter (per-AI):** translate host hook format → engram CLI args. ~30 LOC each.
- **Kernel (engram core):** all LLM calls, schema validation, DB writes. Written once.

Adding a 4th AI later = one new adapter file. Zero core duplication.

---

## 4. Components

### 4.1 New engram CLI commands

#### `engram context <prompt> [--max-tokens N] [--strategy graph|semantic|hybrid]`

Wraps existing `get_context` MCP tool. Returns either:
- `stdout` JSON: `{ additionalContext: "<formatted memory>" }` — direct hook output
- exit 0 with empty body if nothing relevant (hook should skip injection)

Latency target: < 200ms p50 (graph strategy).

#### `engram autosave <transcript-path> [--provider auto|anthropic|openai|google] [--dry-run]`

Steps:
1. Read transcript file (newline-delimited messages).
2. Resolve provider: `auto` reads `$ENGRAM_HOST_AI` env (set by adapter), falls back to config, falls back to Anthropic.
3. Construct extraction prompt (see §6 schema).
4. Call provider's light model.
5. Validate response against engram-locked JSON schema.
6. For each extracted item: query existing nodes first; emit `mutate_state` (create or update) or skip if duplicate.
7. Print summary to stderr: `[engram] autosave: 3 created, 1 updated, 2 skipped`.

Exit codes: 0 success, 1 schema violation, 2 provider error. Hooks ignore non-zero (no session disruption).

### 4.2 Per-AI adapters

All live under `~/.engram/hooks/<ai>/`. Two scripts each:

| AI | On user prompt | On session stop | Hook config |
|----|---------------|-----------------|-------------|
| Claude Code | `prompt-inject.mjs` | `stop-autosave.mjs` | `~/.claude/settings.json` `hooks.UserPromptSubmit`, `hooks.Stop` |
| Codex CLI | `prompt-inject.sh` | `stop-autosave.sh` | **TBD** — needs verification of Codex CLI hook system |
| Gemini CLI | `prompt-inject.sh` | `stop-autosave.sh` | **TBD** — needs verification of Gemini CLI hook system |

> ⚠️ Codex CLI and Gemini CLI hook mechanisms need verification before adapter implementation. If they don't expose pre/post-turn hooks, fallback strategy: a long-running daemon watches their session log files (tail -f) and emits hook-equivalent events. Documented as Phase 2 risk.

### 4.3 Engram-side schema (extraction output)

Strict JSON the autosave LLM must produce:

```jsonc
{
  "items": [
    {
      "kind": "decision" | "preference" | "fact" | "insight" | "person" | "project_update",
      "name": "string (canonical name for dedup)",
      "summary": "1-2 sentence summary",
      "properties": { /* free-form, kind-specific */ },
      "confidence": 0.0 - 1.0,
      "links": [
        { "predicate": "decided_in" | "discovered_in" | "knows" | "...",
          "target_name": "string" }
      ]
    }
  ]
}
```

The autosave kernel rejects anything not matching this and logs the violation. No partial inserts.

---

## 5. Data flow

### 5.1 Per-turn auto-inject

```
user types prompt
    │
    ▼
host AI fires UserPromptSubmit (or equivalent)
    │
    ▼
adapter reads prompt from stdin JSON
    │
    ▼
adapter execs: `engram context "<prompt>" --max-tokens 1500 --strategy hybrid`
    │
    ▼
engram CLI calls get_context internally (graph + semantic)
    │
    ▼
returns { additionalContext: "[Engram] relevant memories: ..." } or empty
    │
    ▼
host AI injects into model's system context for this turn only
```

Budget: 1500 tokens default. Adjustable per AI in adapter config.

### 5.2 Post-session auto-save

```
user ends session (or idle timeout)
    │
    ▼
host AI fires Stop hook (or session-end equivalent)
    │
    ▼
adapter resolves transcript path (host-AI specific)
    │
    ▼
adapter execs: `engram autosave <path> --provider auto`
    │  (env: ENGRAM_HOST_AI=claude|codex|gemini)
    ▼
kernel: select provider's light model
    │
    ▼
kernel: send transcript + extraction prompt
    │
    ▼
kernel: validate JSON response against schema
    │
    ▼
kernel: for each item, dedup-check via query_engram, then mutate_state
    │
    ▼
kernel: print summary to stderr (visible in next session start)
```

Failure modes (all non-fatal):
- Provider down → log, skip, no retry (next session covers it)
- Transcript missing → log "no transcript found", exit 0
- Schema violation → log raw output, exit 1, host AI ignores

---

## 6. Extraction prompt (kernel-side, model-agnostic)

```
You are an extraction agent for Engram, a persistent memory graph.

Input: a transcript of a recent AI ↔ user session.

Task: extract anything SUBSTANTIVE worth remembering across sessions:
  - decisions (architectural, design, tooling)
  - preferences ("user prefers X", "user dislikes Y")
  - facts about people, projects, systems mentioned
  - non-obvious insights or gotchas discovered
  - project state updates (milestones, blockers)

DO NOT extract:
  - greetings, acknowledgments, simple Q&A
  - the model's own clarifying questions
  - syntax lookups or general programming knowledge
  - anything reversed or abandoned within the same session
    (only the FINAL state matters)

Output: strict JSON matching this schema (no prose, no markdown):
<schema from §4.3>

If nothing substantive was discussed, return { "items": [] }.
```

Same prompt for all providers. Differences in extraction quality are absorbed by the schema lock.

---

## 7. Config

`~/.engram/config.json` (new):

```jsonc
{
  "twin_mode": {
    "enabled": true,
    "auto_inject": {
      "enabled": true,
      "max_tokens": 1500,
      "strategy": "hybrid"
    },
    "auto_save": {
      "enabled": true,
      "provider": "auto",      // auto | anthropic | openai | google
      "model_override": null,  // e.g. "claude-haiku-4-5" to force
      "min_transcript_tokens": 500   // skip tiny sessions
    }
  }
}
```

CLI control: `engram twin enable | disable | status`.

---

## 8. Phased rollout

### Phase 1 — Kernel (1–2 days)
- [ ] `engram context` CLI command (wraps existing `get_context`)
- [ ] `engram autosave` CLI command with Anthropic provider only
- [ ] Schema validator (zod or hand-rolled)
- [ ] Dedup logic (query before mutate)
- [ ] Config loader
- [ ] Unit tests (provider mocked)

### Phase 2 — Claude Code adapter (½ day)
- [ ] `prompt-inject.mjs` (replaces current `prompt-nudge.mjs`)
- [ ] `stop-autosave.mjs`
- [ ] `engram onboard` updates to install both
- [ ] Manual end-to-end test on this very repo

### Phase 3 — Multi-provider (½ day)
- [ ] OpenAI provider (gpt-mini class)
- [ ] Google provider (Flash class)
- [ ] Provider auto-detection from `$ENGRAM_HOST_AI`

### Phase 4 — Codex CLI adapter (1 day, blocked on hook research)
- [ ] Verify Codex CLI hook system (or fallback to log-tailing daemon)
- [ ] `~/.engram/hooks/codex/` scripts
- [ ] Codex install path in `engram onboard`

### Phase 5 — Gemini CLI adapter (1 day, same blockers)
- [ ] Verify Gemini CLI hook system
- [ ] `~/.engram/hooks/gemini/` scripts
- [ ] Gemini install path in `engram onboard`

### Phase 6 — Polish
- [ ] `engram twin status` shows last-injection / last-autosave per AI
- [ ] Cost telemetry (`engram usage --twin`)
- [ ] Docs

Each phase ships independently. Phase 1+2 alone delivers a working Claude Code "분신". Phases 3–5 expand it.

---

## 9. Risks & open questions

1. **Codex/Gemini hook surface unknown.** If neither exposes per-turn hooks, log-tailing daemon adds complexity. Need to research before Phase 4.
2. **Transcript access.** Each AI stores transcripts differently. Adapter must locate the current session's transcript file — needs per-AI mapping.
3. **Latency on auto-inject.** 200ms target needs benchmarking. If `get_context` exceeds budget, fall back to graph-only (skip semantic).
4. **Cost runaway.** Worst case: a chatty user with 50 sessions/day on Haiku ≈ $18/month. Add a daily cap in config (`max_autosave_calls_per_day`).
5. **Privacy.** Transcript → 3rd-party LLM. User must opt-in explicitly during `engram onboard`. Default = disabled until opted in.
6. **Dedup quality.** Naive name-match dedup will miss semantic duplicates ("Bun preference" vs "Use bun"). Phase 6 candidate: embedding-based dedup.
7. **Cross-process race on autosave dedup.** `getNodeByName → mutate(create)` is not atomic and the `nodes` table has no `UNIQUE(name)` constraint. Two autosave processes running simultaneously can each insert a duplicate node. Phase 1 mitigation: Stop hooks fire once per session, so collisions are rare. Phase 4+ multi-process protection: add a unique partial index on `(namespace, name)` for non-archived nodes, or wrap autosave in an advisory lock.
8. **Re-running autosave on the same transcript.** No idempotency key; each run bumps node `version` even if extracted items haven't changed. Phase 1 mitigation: Stop hook is one-shot per session. Phase 6 fix: persist a transcript content-hash → autosave-result map, skip on hit.

---

## 10. Out of scope (explicit)

- Web AI surfaces (ChatGPT web, Claude.ai web, Custom GPTs)
- Multi-machine sync (Syncthing, git backend, cloud)
- Real-time streaming injection (mid-turn updates)
- Conflict resolution UI for contradictory memories
- Per-AI memory partitioning (single shared identity is the point)

---

## 11. Success criteria

After Phase 2 ships:
- ✅ Open Claude Code in this repo, ask a question — relevant memories appear in model's context without me typing anything
- ✅ Discuss a new design decision in chat, end the session — next session shows that decision was saved automatically
- ✅ Cost stays under $1/day for normal use (≤20 sessions)
- ✅ Zero session disruptions when network is down (hooks fail silently)

After Phase 5 ships:
- ✅ All three above, but on Codex CLI and Gemini CLI too, sharing the same `engram.db`
