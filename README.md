<p align="center">
  <h1 align="center">Engram</h1>
  <p align="center">
    <strong>AI-native persistent memory for agents — knowledge graph, not files, not RAG.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="#three-interfaces-one-memory">Interfaces</a> &middot;
    <a href="#architecture">Architecture</a> &middot;
    <a href="#configuration">Configuration</a> &middot;
    <a href="#production-deployment">Production</a>
  </p>
</p>

---

Engram is an **MCP server** that gives AI agents a structured, persistent memory as a **knowledge graph**. Instead of stuffing context into markdown files or re-embedding every conversation, Engram separates immutable history from mutable state — so an agent can update a single fact in O(1), not rewrite an entire document.

```
Agent learns "Alice got promoted"
  → mutate_state({ op: "update", node_id: "alice", set: { role: "lead" } })
  → One row updated. Old value preserved in history. Event log chained.

Agent needs context about Alice
  → get_context({ entities: ["Alice"], max_tokens: 2000 })
  → Alice [person] (conf: 0.95)
     Lead engineer on platform team
     → works_on: Engram
     → knows: Bob
     ← manages: Charlie
```

## Why Engram?

| Problem | Traditional Approach | Engram |
|---------|---------------------|--------|
| Update a fact | Rewrite / summarize entire doc | `UPDATE nodes SET … WHERE id = ?` |
| Recall an entity | Embed + search + pray | Direct O(1) graph lookup |
| Track relationships | Implicit in prose | Explicit SPO triplets with confidence |
| Audit trail | Overwritten and lost | Immutable event log with SHA-256 chain |
| Multi-user / multi-project | Shared pile | First-class namespaces |
| Token cost | Dump everything into context | Budget-controlled, relevance-ranked injection |
| Keyword search at 10K+ nodes | Falls apart | FTS5, sub-1 ms |

## Quick Start

```bash
git clone https://github.com/kooroot/Engram.git
cd Engram
bun install
bun run build

# Use as global CLI
bun link
engram status
```

### Hook into an agent

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/absolute/path/to/Engram/dist/index.js"],
      "env": { "ENGRAM_DATA_DIR": "/path/to/data" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add engram node /absolute/path/to/Engram/dist/index.js
```

**Cursor / any MCP-compatible client:** point `command` at `node /path/to/Engram/dist/index.js`.

## Three Interfaces, One Memory

Engram exposes the same underlying knowledge graph through three access modes:

| Mode | Who uses it | How |
|------|-------------|-----|
| **MCP Server** | AI agents (Claude, Cursor, custom) | `engram mcp` (or auto-detected piped stdin) |
| **CLI** | Humans in a terminal | `engram status`, `engram search …` |
| **REST API** | Web dashboards, external apps, SaaS | `engram serve --port 3333` |

All three share the same `src/service.ts` layer, so behavior is consistent.

### CLI

```bash
engram status                              # namespace stats + semantic flag
engram nodes --type person                 # list nodes filtered by type
engram node "Alice"                        # full detail (props, edges, version)
engram edges "Engram"                      # relationships in both directions
engram search "platform engineer"          # FTS5-backed keyword search
engram events --limit 10                   # recent events from the log
engram history "Alice"                     # version-by-version timeline
engram context "Engram roadmap" \
  --strategy hybrid --max-tokens 2000      # same injection an agent would get
engram maintenance --dry-run               # decay / archive / orphan preview

# Multi-tenant
engram --namespace work status
engram --namespace personal nodes --type note
engram namespaces                          # list all tenants in the DB

# Dedupe
engram merge Alice-v1 Alice-v2             # re-points edges + archives source

# Backup / restore
engram --namespace work export > work.json
engram import work.json --target backup --strategy reassign

# Start the REST server
engram serve --port 3333 --host 127.0.0.1
```

### REST API

All endpoints accept `?namespace=xyz` query param or `X-Engram-Namespace` header for per-request tenant routing.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness probe (always public) |
| `GET` | `/api/metrics` | Prometheus text format |
| `GET` | `/api/status` | Graph stats for current namespace |
| `GET` | `/api/namespaces` | List all namespaces in DB |
| `GET` | `/api/nodes?type=&limit=` | List nodes (optionally filtered by type) |
| `GET` | `/api/nodes/:id` | Node detail + in/out edges |
| `GET` | `/api/edges/:nodeId` | Edges for a specific node |
| `GET` | `/api/search?q=…` | FTS5 keyword search |
| `GET` | `/api/events?limit=&type=` | Recent events |
| `GET` | `/api/history/:nodeId` | Version history of a node |
| `POST` | `/api/context` | Build injection context for a topic/entities |
| `POST` | `/api/merge` | `{ source, target }` — merge duplicates |
| `GET` | `/api/export?archived=&events=&history=` | Full namespace dump |
| `POST` | `/api/import` | `{ bundle, strategy, targetNamespace }` |

### MCP Tools

| Tool | Purpose |
|------|---------|
| `mutate_state` | Create / update / delete nodes (batched, atomic) |
| `link_entities` | Create / update / delete SPO edges (auto-upsert on triplet) |
| `query_engram` | Lookup by id/name/type, or BFS graph traversal (depth ≤ 5) |
| `get_context` | Primary read path — graph + semantic hybrid, token budgeted |
| `search_memory` | Semantic KNN vector search (requires embedding provider) |
| `log_event` | Append to immutable event log |
| `merge_nodes` | Unify duplicate entities (re-points edges, archives source) |

Tools validate inputs with Zod (size and count caps applied). Tool call failures return structured errors; the MCP server logs them and continues.

## Architecture

```
                         ┌────────────────────────┐
                         │      Access Modes      │
                         │ MCP / CLI / REST API   │
                         └───────────┬────────────┘
                                     │
                         ┌───────────▼────────────┐
                         │     Service Layer      │
                         │  (src/service.ts)      │
                         └───────────┬────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
   ┌──────▼───────┐          ┌───────▼────────┐         ┌───────▼────────┐
   │   Engine     │          │   DB Layer     │         │  Embeddings    │
   │              │          │                │         │                │
   │ BFS graph    │          │ EventLog       │         │ OpenAI API     │
   │ Context bld  │          │ StateTree      │         │ Local (hash)   │
   │ LRU cache    │          │ VectorStore    │         │ Auto-embed on  │
   │ Maintenance  │          │ (namespaced)   │         │  mutation      │
   │ Conflict res │          │                │         │                │
   └──────┬───────┘          └───────┬────────┘         └────────────────┘
          │                          │
          │                  ┌───────▼────────────────────────────┐
          │                  │         SQLite (WAL mode)          │
          │                  ├────────────────────┬───────────────┤
          │                  │   engram.db        │ engram-vec.db │
          │                  │                    │               │
          │                  │ events             │ embeddings    │
          │                  │ nodes              │ vec_embeddings│
          │                  │ edges              │  (sqlite-vec) │
          │                  │ node_history       │               │
          │                  │ nodes_fts (FTS5)   │               │
          │                  │ _migrations        │               │
          └──────────────────┴────────────────────┴───────────────┘
```

### Three-Tier Memory

| Tier | Role | Analogy | Storage |
|------|------|---------|---------|
| **Event Log** | What happened | Subconscious | Append-only, SHA-256 checksum chain per namespace |
| **Cognitive State** | What is true now | Conscious | Nodes + edges (SPO triplets), FTS5-indexed |
| **Vector Store** | What feels related | Intuition | sqlite-vec KNN over auto-generated embeddings |

### Design Principles

1. **No O(N) Rewrites** — Updating one fact = one row update
2. **O(1) State Lookups** — Direct index/graph lookup, not search-and-hope
3. **Explicit State Transitions** — Agents emit atomic tool calls, not prose
4. **Token Efficiency** — Pre-computed summaries + budget-controlled injection
5. **Immutable History** — Full audit trail with cryptographic integrity
6. **Tenant Isolation** — Namespaces separate nodes, edges, events, history, embeddings, and event chains

## Configuration

All settings come from env vars (or `.env`, if you source one — see `.env.example`).

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_DATA_DIR` | `./data` | Directory for database files |
| `ENGRAM_DB_FILENAME` | `engram.db` | Main DB filename |
| `ENGRAM_VEC_DB_FILENAME` | `engram-vec.db` | Vector DB filename |

### Multi-Tenancy

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_NAMESPACE` | `default` | Namespace used when no override is provided |
| `ENGRAM_NAMESPACE_ALLOWLIST` | — | Comma-separated list; if set, rejects per-request namespaces not in the list |
| `ENGRAM_CORE_CACHE_SIZE` | `32` | Max concurrent namespace cores held in memory (LRU) |

### Embedding / Semantic Search

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_EMBEDDING_PROVIDER` | `none` | `openai`, `local`, or `none` |
| `OPENAI_API_KEY` | — | Setting this auto-enables OpenAI embeddings |
| `OPENAI_BASE_URL` | — | Custom OpenAI-compatible endpoint |

### REST API Security / Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_API_TOKEN` | — | Bearer token(s) for REST API (comma-separated). Unset = auth off |
| `ENGRAM_TRUST_PROXY` | — | Set to `1` to honor `X-Forwarded-For` (only behind a trusted proxy) |
| `ENGRAM_RATE_BURST` | `60` | Token-bucket burst capacity |
| `ENGRAM_RATE_PER_SEC` | `10` | Sustained refill rate |
| `ENGRAM_RATE_LIMIT` | — | Set to `off` to disable rate limiting |
| `ENGRAM_CORS_ORIGIN` | `*` | CORS origin for REST |
| `ENGRAM_CONTEXT_MAX_BYTES` | `64000` | `POST /api/context` body limit |
| `ENGRAM_IMPORT_MAX_BYTES` | `16777216` | `POST /api/import` body limit |

### Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ENGRAM_LOG_FORMAT` | `json` | `json` or `pretty` |
| `ENGRAM_METRIC_NAMESPACES` | — | Comma-separated allowlist for `namespace=` metric labels; unknown values collapse to `_other` |

## Production Deployment

```bash
# /etc/engram.env
ENGRAM_DATA_DIR=/var/lib/engram
ENGRAM_API_TOKEN=$(openssl rand -hex 32)
ENGRAM_NAMESPACE_ALLOWLIST=default,acme-prod,acme-staging
ENGRAM_METRIC_NAMESPACES=default,acme-prod,acme-staging
ENGRAM_RATE_BURST=120
ENGRAM_RATE_PER_SEC=30
ENGRAM_TRUST_PROXY=1          # only if behind a real reverse proxy
ENGRAM_CORS_ORIGIN=https://app.example.com
ENGRAM_LOG_FORMAT=json
ENGRAM_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...

engram serve --port 3333 --host 0.0.0.0
```

### Observability endpoints

- `GET /api/health` — always-public liveness probe (exempt from auth & rate-limit)
- `GET /api/metrics` — Prometheus text format, includes:
  - `engram_mutations_total{namespace, kind}`
  - `engram_context_requests_total{namespace, strategy}`
  - `engram_cache_hits_total / engram_cache_misses_total{kind}`
  - `engram_embeddings_total / engram_embedding_failures_total{namespace}`
  - `engram_api_requests_total{method, path, status}`
  - `engram_api_errors_total`
  - `engram_auth_failures_total{reason}`
  - `engram_mutation_duration_seconds` / `engram_context_duration_seconds` histograms

Every response sets `X-Request-ID` so structured logs can be correlated.

### Security model

- **Auth**: Bearer token via `Authorization: Bearer <token>`. Multiple tokens (comma-separated) supported for rotation. Comparison is `crypto.timingSafeEqual`. `/api/health` is exempt; everything else requires a valid token when `ENGRAM_API_TOKEN` is set.
- **Rate limiting**: Token bucket per client. Client identity = token fingerprint (SHA-256 truncated) if authed, else socket remote address. Only honors `X-Forwarded-For` when `ENGRAM_TRUST_PROXY=1`.
- **Namespace isolation**: Node IDs, edge triplets, event chains, history, embeddings — all per-namespace. Imports refuse to clobber nodes in another namespace. `link_entities` rejects cross-namespace source/target refs.
- **Input caps**: Zod schemas cap operation counts, property counts, string lengths, array sizes. Body limits per endpoint.

## Development

```bash
bun install                    # Install dependencies
bun run dev                    # Start dev MCP server via tsx
bun run build                  # Compile TypeScript + copy migrations
bun run test                   # Run all tests (79 currently)
bun run test:watch             # Watch mode
bun run typecheck              # Type check only
```

### Project Structure

```
src/
  config/                      Zod-validated config, env precedence
  db/                          SQLite layer (namespace-scoped)
    migrations/                SQL schema migrations (tracked)
    event-log.ts               Immutable log with per-namespace SHA-256 chain
    state-tree.ts              Node/edge CRUD, history, FTS5, merge
    vector-store.ts            sqlite-vec KNN
  engine/                      Pure algorithms
    graph-traversal.ts         BFS (≤ depth 5), cycle detection
    context-builder.ts         Token-budgeted serialization
    cache.ts                   In-memory node + LRU context
    maintenance.ts             Decay, archive, orphan GC
    conflict-resolver.ts       Duplicate detection
  embeddings/                  Provider abstraction
    openai.ts                  OpenAI embedding API
    local.ts                   Deterministic hash (testing)
  tools/                       7 MCP tool handlers
  cli/                         CLI commands + colorized formatters
  api/                         Hono REST app (auth, rate-limit, CORS)
  service.ts                   Shared layer for CLI + REST + MCP
  server.ts                    MCP server factory
  metrics.ts                   Prometheus registry (zero-dep)
  logger.ts                    Structured JSON logger
  rate-limit.ts                Token-bucket limiter
  port.ts                      JSON import/export
  utils.ts                     safeJsonParse
  index.ts                     Entry — auto-routes MCP (piped stdin) vs CLI
tests/
  unit/                        Per-module tests
  integration/                 End-to-end lifecycle
  fixtures/                    Test graph data
scripts/
  populate-test-data.ts        Seed data for manual E2E
  populate-ns.ts               Multi-namespace test data
  verify-advanced.ts           Advanced feature verification
  bench-fts.ts                 FTS5 benchmark
```

### Running a scenario end-to-end

```bash
# 1. Seed a test graph
ENGRAM_DATA_DIR=/tmp/engram-demo \
  ENGRAM_EMBEDDING_PROVIDER=local \
  bun run src/index.ts  # (or npx tsx scripts/populate-test-data.ts)

# 2. Browse via CLI
ENGRAM_DATA_DIR=/tmp/engram-demo engram status
ENGRAM_DATA_DIR=/tmp/engram-demo engram context "AI memory" --strategy hybrid

# 3. Start REST and query
ENGRAM_DATA_DIR=/tmp/engram-demo engram serve --port 3333 &
curl http://localhost:3333/api/status
curl -X POST http://localhost:3333/api/context \
  -H 'Content-Type: application/json' \
  -d '{"topic":"AI memory","max_tokens":500}'

# 4. Connect via MCP (e.g., Claude Desktop)
#    → see Quick Start
```

## How It Works

```
User: "Alice just moved to the platform team."

Agent flow:
1. get_context({ entities: ["Alice"] })
   → Engram returns Alice's current state + 1-hop neighbors

2. mutate_state({
     operations: [{ op: "update", node_id: "...", set: { team: "platform" } }]
   })
   → Atomic transaction:
     - Snapshot old state to node_history (rowid tracked)
     - UPDATE nodes SET ... WHERE id = ? AND namespace = ?
     - Append mutation event (per-namespace SHA-256 chain)
     - Link event_id back to both node and history row
     - Invalidate cache entries for this node
     - Fire onMutate callback → re-embed in background

3. Next conversation:
   get_context({ topic: "platform team" })
   → FTS5 finds Alice (name + summary + properties match)
   → Semantic search finds semantically related nodes
   → BFS expands 1 hop from anchors
   → Context builder serializes within token budget
```

## License

MIT
