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
| `ENGRAM_EMBEDDING_PROVIDER` | `none` | `openai`, `local`, or `none` |
| `OPENAI_API_KEY` | — | Auto-enables OpenAI embeddings when set |
| `OPENAI_BASE_URL` | — | Custom OpenAI-compatible endpoint |

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
