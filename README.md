<p align="center">
  <h1 align="center">Engram</h1>
  <p align="center">
    <strong>AI-native persistent memory for agents — not files, not RAG, just state.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="#architecture">Architecture</a> &middot;
    <a href="#mcp-tools">Tools</a> &middot;
    <a href="#configuration">Config</a>
  </p>
</p>

---

Engram is an **MCP server** that gives AI agents a structured, persistent memory as a **knowledge graph**. Instead of stuffing context into markdown files or re-embedding every conversation, Engram separates immutable history from mutable state — so your agent can update a single fact in O(1), not rewrite an entire document.

```
Agent learns "Alice got promoted"
  → mutate_state({ op: "update", node_id: "alice", set: { role: "lead" } })
  → Done. One row updated. Old value preserved in history.

Agent needs context about Alice
  → get_context({ entities: ["Alice"], max_tokens: 2000 })
  → Returns: Alice [person] (conf: 0.95)
              Senior engineer → lead (updated 2m ago)
              → works_on: Engram
              → knows: Bob
```

## Why Engram?

| Problem | Traditional Approach | Engram |
|---------|---------------------|--------|
| Update a fact | Rewrite/summarize entire doc | `UPDATE nodes SET ... WHERE id = ?` |
| Recall an entity | Embed + search + pray | Direct O(1) graph lookup |
| Track relationships | Implicit in prose | Explicit SPO triplets with confidence |
| Audit trail | Overwritten and lost | Immutable event log with checksum chain |
| Token cost | Dump everything into context | Budget-controlled, relevance-ranked injection |

## Quick Start

```bash
# Clone & install
git clone https://github.com/kooroot/engram.git
cd engram
bun install

# Build
bun run build

# Run (stdio transport for MCP)
node dist/index.js
```

### Add to Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/absolute/path/to/engram/dist/index.js"],
      "env": {
        "ENGRAM_DATA_DIR": "/path/to/data"
      }
    }
  }
}
```

### Add to Claude Code

```bash
claude mcp add engram node /absolute/path/to/engram/dist/index.js
```

### Add to Cursor

Settings > MCP Servers > Add:

```json
{
  "engram": {
    "command": "node",
    "args": ["/absolute/path/to/engram/dist/index.js"]
  }
}
```

## Usage Modes

Engram has three interfaces — pick the one that fits:

| Mode | For | Command |
|------|-----|---------|
| **MCP Server** | AI agents (Claude, Cursor) | `engram mcp` or auto-detected via piped stdin |
| **CLI** | Humans in terminal | `engram status`, `engram nodes`, `engram search ...` |
| **REST API** | Web dashboards, apps | `engram serve --port 3333` |

### CLI Examples

```bash
# What's in memory?
engram status

# List all people
engram nodes --type person

# Inspect a specific entity
engram node "Alice"

# Search for something
engram search "platform team"

# See what the AI has been doing
engram events --limit 10

# View how a node changed over time
engram history "Alice"

# Get the same context an AI agent would see
engram context "project status" --entities "Alice,Engram"

# Run maintenance (decay stale nodes, archive, clean orphans)
engram maintenance --dry-run

# Multi-namespace workflows
engram --namespace work status              # stats for 'work' namespace
engram --namespace personal nodes --type person
engram namespaces                           # list all namespaces

# Merge duplicate entities (re-points edges, archives source)
engram merge Alice-v1 Alice-v2

# Backup / restore
engram --namespace work export > backup.json
engram import backup.json --target work-restored --strategy reassign
```

### REST API

```bash
# Start the API server
engram serve --port 3333

# Then query from anywhere
curl http://localhost:3333/api/status
curl http://localhost:3333/api/nodes?type=person
curl http://localhost:3333/api/nodes/Alice
curl http://localhost:3333/api/search?q=engineer
curl http://localhost:3333/api/events?limit=10
curl http://localhost:3333/api/history/Alice
curl -X POST http://localhost:3333/api/context \
  -H 'Content-Type: application/json' \
  -d '{"topic": "project status", "entities": ["Alice"]}'
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Engram MCP Server                    │
│                                                          │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────────┐  │
│  │  Tools   │  │   Engine    │  │    Embeddings      │  │
│  │          │  │             │  │                    │  │
│  │ mutate   │  │ BFS Graph   │  │ OpenAI / Local    │  │
│  │ link     │  │ Context     │  │ Auto-embed on     │  │
│  │ query    │  │ Cache (LRU) │  │ mutation          │  │
│  │ context  │  │ Maintenance │  │                    │  │
│  │ search   │  │ Conflict    │  │                    │  │
│  │ log      │  │ Resolution  │  │                    │  │
│  └────┬─────┘  └──────┬──────┘  └─────────┬──────────┘  │
│       │               │                    │             │
│  ┌────┴───────────────┴────────────────────┴──────────┐  │
│  │              SQLite (WAL mode)                     │  │
│  ├──────────────────────┬─────────────────────────────┤  │
│  │    engram.db         │      engram-vec.db          │  │
│  │                      │                             │  │
│  │  events (immutable)  │  embeddings (metadata)      │  │
│  │  nodes  (entities)   │  vec_embeddings (sqlite-vec)│  │
│  │  edges  (triplets)   │                             │  │
│  │  node_history (audit)│                             │  │
│  │  _migrations         │                             │  │
│  └──────────────────────┴─────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Three-Tier Memory

| Tier | Role | Analogy | Storage |
|------|------|---------|---------|
| **Event Log** | What happened | Subconscious | Append-only table, SHA-256 checksum chain |
| **Cognitive State** | What is true now | Conscious | Knowledge graph (nodes + edges as SPO triplets) |
| **Vector Store** | What feels related | Intuition | sqlite-vec KNN search (optional) |

### Design Principles

1. **No O(N) Rewrites** — Updating one fact = one row update, not a document rewrite
2. **O(1) State Lookups** — Direct index/graph lookup, not search-and-hope
3. **State Transitions** — AI emits atomic tool calls to patch specific nodes
4. **Token Efficiency** — Pre-computed summaries, budget-controlled context injection
5. **Immutable History** — Full audit trail with cryptographic integrity chain

## MCP Tools

### `mutate_state` — Create, update, delete entities

```json
{
  "operations": [
    {
      "op": "create",
      "type": "person",
      "name": "Alice",
      "properties": { "role": "engineer", "team": "platform" },
      "summary": "Senior platform engineer, leads Engram project"
    },
    {
      "op": "update",
      "node_id": "01JXYZ...",
      "set": { "role": "lead engineer" }
    }
  ]
}
```

All operations run in a single atomic transaction. Duplicate names trigger a warning with the existing node ID.

### `link_entities` — Connect entities with relationships

```json
{
  "operations": [
    {
      "op": "create",
      "source_id": "01JXYZ...",
      "predicate": "works_on",
      "target_id": "01JABC..."
    }
  ]
}
```

Duplicate triplets are auto-upserted. Standard predicates: `works_on`, `knows`, `is_a`, `prefers`, `located_in`, `reports_to`, `uses`.

### `query_engram` — Look up entities or traverse the graph

```json
{
  "node_name": "Alice",
  "traverse": {
    "from": "Alice",
    "direction": "outgoing",
    "depth": 2,
    "predicates": ["works_on", "knows"]
  }
}
```

BFS traversal up to depth 5 with predicate filtering, direction control, and cycle detection.

### `get_context` — Fetch relevant context for prompt injection

```json
{
  "topic": "project status",
  "entities": ["Alice", "Engram"],
  "max_tokens": 2000,
  "strategy": "hybrid"
}
```

The primary read-path tool. Combines graph traversal and semantic search, ranks by confidence and recency, serializes to a token-efficient format within the specified budget.

### `search_memory` — Semantic vector search

```json
{
  "query": "who works on the AI project",
  "limit": 5,
  "min_similarity": 0.7
}
```

Requires an embedding provider (OpenAI or local). Embeddings are auto-generated on node creation/update.

### `log_event` — Append to the immutable event log

```json
{
  "type": "observation",
  "source": "agent",
  "content": { "note": "User prefers dark mode" }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_DATA_DIR` | `./data` | Directory for database files |
| `ENGRAM_DB_FILENAME` | `engram.db` | Main database filename |
| `ENGRAM_VEC_DB_FILENAME` | `engram-vec.db` | Vector database filename |
| `ENGRAM_NAMESPACE` | `default` | Memory namespace (multi-tenant isolation) |
| `ENGRAM_EMBEDDING_PROVIDER` | `none` | `openai`, `local`, or `none` |
| `OPENAI_API_KEY` | — | Auto-enables OpenAI embeddings when set |
| `OPENAI_BASE_URL` | — | Custom OpenAI-compatible endpoint |
| `ENGRAM_API_TOKEN` | — | Bearer token(s) for REST API (comma-separated) |
| `ENGRAM_RATE_BURST` | `60` | Rate limit: burst capacity |
| `ENGRAM_RATE_PER_SEC` | `10` | Rate limit: sustained rate per second |
| `ENGRAM_RATE_LIMIT` | — | Set to `off` to disable rate limiting |
| `ENGRAM_CORS_ORIGIN` | `*` | CORS origin for REST API |
| `ENGRAM_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ENGRAM_LOG_FORMAT` | `json` | `json` or `pretty` |

### Production Deployment

```bash
# Typical production REST API setup
export ENGRAM_DATA_DIR=/var/lib/engram
export ENGRAM_API_TOKEN="$(openssl rand -hex 32)"
export ENGRAM_RATE_BURST=100
export ENGRAM_RATE_PER_SEC=20
export ENGRAM_CORS_ORIGIN=https://app.example.com
export ENGRAM_LOG_LEVEL=info
export ENGRAM_LOG_FORMAT=json
export OPENAI_API_KEY=sk-...

engram serve --port 3333 --host 0.0.0.0
```

Observability endpoints:
- `GET /api/health` — liveness probe (always public, exempt from auth/rate-limit)
- `GET /api/metrics` — Prometheus text format (requires auth if configured)

Scrape `/api/metrics` with Prometheus; the exposed metrics include mutation
and context latency histograms, cache hit rates, embedding success/failure,
and per-endpoint request/error counters.

### Semantic Search Setup

Engram works without any API keys — graph-based memory is fully functional out of the box. To enable semantic (fuzzy) search:

```bash
# Option 1: OpenAI embeddings (recommended)
export OPENAI_API_KEY=sk-...

# Option 2: Local deterministic embeddings (no API, for testing)
export ENGRAM_EMBEDDING_PROVIDER=local
```

## Development

```bash
bun install            # Install dependencies
bun run dev            # Start dev server (tsx)
bun run build          # Compile TypeScript
bun run test           # Run tests (50 tests)
bun run test:watch     # Watch mode
bun run typecheck      # Type check only
```

### Project Structure

```
src/
  config/         Config loader with Zod validation
  db/             SQLite layer: EventLog, StateTree, VectorStore
    migrations/   SQL schema migrations (version-tracked)
  engine/         Graph traversal, context builder, cache, maintenance
  embeddings/     OpenAI and local embedding providers
  tools/          6 MCP tool handlers
  server.ts       MCP server creation and wiring
  index.ts        Entry point (stdio transport)
tests/
  unit/           Unit tests for each module
  integration/    End-to-end lifecycle tests
  fixtures/       Test graph data
```

## How It Works

```
User says: "Alice just moved to the platform team"

1. Agent calls get_context({ entities: ["Alice"] })
   → Engram returns Alice's current state from the graph

2. Agent calls mutate_state({
     operations: [{ op: "update", node_id: "...", set: { team: "platform" } }]
   })
   → Node updated atomically
   → Old state preserved in node_history
   → Mutation logged to immutable event log
   → Cache invalidated
   → Embedding auto-regenerated

3. Next conversation, agent calls get_context({ topic: "platform team" })
   → Alice appears in results with updated team
   → No re-indexing, no document rewrite, no token waste
```

## License

MIT
