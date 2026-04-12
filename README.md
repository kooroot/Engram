# Engram

AI-native persistent memory space with state-transition architecture.

Engram is an MCP (Model Context Protocol) server that gives AI agents a structured, queryable memory system. Instead of file-based notes or raw RAG, Engram separates **History** (immutable event log) from **Cognitive State** (mutable knowledge graph), enabling O(1) state lookups and atomic state transitions.

## Architecture

```
┌─────────────────────────────────────────────┐
│                MCP Server                    │
│  ┌─────────┐ ┌─────────┐ ┌───────────────┐ │
│  │ Tools   │ │ Engine  │ │ Embeddings    │ │
│  │ 6 tools │ │ Graph   │ │ OpenAI/Local  │ │
│  │         │ │ Context │ │               │ │
│  │         │ │ Cache   │ │               │ │
│  └────┬────┘ └────┬────┘ └───────┬───────┘ │
│       │           │               │         │
│  ┌────┴───────────┴───────────────┴───────┐ │
│  │           SQLite (WAL mode)            │ │
│  ├────────────────┬───────────────────────┤ │
│  │  engram.db     │    engram-vec.db      │ │
│  │  - events      │    - embeddings       │ │
│  │  - nodes       │    - vec_embeddings   │ │
│  │  - edges       │      (sqlite-vec)     │ │
│  │  - node_history│                       │ │
│  └────────────────┴───────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Three-Tier Memory

| Tier | Purpose | Storage |
|------|---------|---------|
| **Event Log** | Immutable audit trail of all actions | `events` table (append-only, checksum chain) |
| **Cognitive State Tree** | Current truth as a knowledge graph | `nodes` + `edges` tables (SPO triplets) |
| **Semantic Vector Store** | Fuzzy search for unstructured context | `sqlite-vec` (optional) |

## Setup

### Prerequisites

- Node.js >= 20
- npm, bun, or yarn

### Install & Build

```bash
bun install
bun run build
```

### Configure MCP Client

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/index.js"],
      "env": {
        "ENGRAM_DATA_DIR": "/path/to/data",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Or for development:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["tsx", "/path/to/engram/src/index.ts"],
      "env": {
        "ENGRAM_DATA_DIR": "/path/to/data"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_DATA_DIR` | `./data` | Directory for database files |
| `ENGRAM_DB_FILENAME` | `engram.db` | Main database filename |
| `ENGRAM_VEC_DB_FILENAME` | `engram-vec.db` | Vector database filename |
| `ENGRAM_EMBEDDING_PROVIDER` | `none` | Embedding provider: `openai`, `local`, or `none` |
| `OPENAI_API_KEY` | — | OpenAI API key (auto-enables OpenAI embeddings) |
| `OPENAI_BASE_URL` | — | Custom OpenAI-compatible API base URL |

## MCP Tools

### `mutate_state`
Create, update, or delete entities (nodes) in the knowledge graph. All operations run atomically.

```json
{
  "operations": [
    { "op": "create", "type": "person", "name": "Alice", "properties": { "role": "engineer" } },
    { "op": "update", "node_id": "01J...", "set": { "role": "lead" } },
    { "op": "delete", "node_id": "01J..." }
  ]
}
```

### `link_entities`
Create, update, or delete relationships (edges) between entities. Duplicate triplets are auto-upserted.

```json
{
  "operations": [
    { "op": "create", "source_id": "01J...", "predicate": "works_on", "target_id": "01J..." }
  ]
}
```

### `query_engram`
Look up entities by ID/name/type, or traverse the graph with BFS up to depth 5.

```json
{
  "node_name": "Alice",
  "traverse": { "from": "Alice", "direction": "outgoing", "depth": 2 }
}
```

### `get_context`
Primary read-path tool. Fetches relevant context for prompt injection with token budget control.

```json
{
  "topic": "project status",
  "entities": ["Alice", "Engram"],
  "max_tokens": 2000,
  "strategy": "hybrid"
}
```

### `search_memory`
Semantic vector search (requires embedding provider).

```json
{ "query": "who works on the AI project", "limit": 5 }
```

### `log_event`
Append to the immutable event log.

```json
{ "type": "observation", "source": "agent", "content": { "note": "User prefers dark mode" } }
```

## Development

```bash
bun run dev          # Start with tsx (development)
bun run build        # Compile TypeScript
bun run test         # Run tests
bun run test:watch   # Watch mode
bun run typecheck    # Type check only
```

## Design Principles

1. **No O(N) Rewrites** — Updating a single fact never requires rewriting a document
2. **O(1) State Lookups** — Direct graph/index lookup for any entity's current truth
3. **State Transitions** — AI emits atomic Tool Calls to patch specific nodes
4. **Token Efficiency** — Pre-computed summaries and budget-controlled context injection
5. **Immutable History** — Every mutation is recorded with checksum chain integrity

## License

MIT
