import type { Node, Edge } from '../types/index.js';

export interface ContextBuildOptions {
  maxTokens: number;
  includeProperties: boolean;
  includeEdges: boolean;
  /** Cap on how many nodes of each `type` are injected (highest-confidence
   *  first). Bounds pathological crowding — e.g. one project accumulating 60+
   *  near-identical `decision` nodes would otherwise dominate the whole token
   *  budget and starve the project summary / insights. Undefined = no cap. */
  maxPerType?: number;
}

const DEFAULT_OPTIONS: ContextBuildOptions = {
  maxTokens: 2000,
  includeProperties: true,
  includeEdges: true,
};

/** Default per-type injection cap for get_context recall blocks (the
 *  SessionStart / UserPromptSubmit hooks). Keeps the top-N highest-confidence
 *  nodes of each type so one over-represented type (e.g. a project's many
 *  near-duplicate decisions) can't crowd out the rest of the token budget.
 *  Exported as the single source of truth for BOTH read paths — the MCP
 *  get_context tool and service.getContext — so they stay in lockstep. */
export const CONTEXT_MAX_PER_TYPE = 6;

/** Max edges rendered per direction (outgoing / incoming) for a single node in
 *  a context block. A hub node can have hundreds of edges; rendering them all
 *  dumps dozens of `-> predicate: target` lines that crowd out other nodes (and
 *  can blow the whole token budget). The highest-confidence, most-recent edges
 *  are kept and the remainder is summarized as `(+N more)`. */
const MAX_EDGES_PER_DIRECTION = 8;

/** Highest-confidence first, then most-recent. Edge confidences are frequently
 *  1.0, so the recency tiebreak keeps the cut deterministic rather than arbitrary. */
function sortEdgesForDisplay(edges: Edge[]): Edge[] {
  return [...edges].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/**
 * Builds a token-efficient text representation of a subgraph
 * suitable for injection into an LLM prompt.
 *
 * Token estimation: ~4 chars per token (rough average for English text).
 */
export function buildContext(
  nodes: Node[],
  edges: Edge[],
  options: Partial<ContextBuildOptions> = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const maxChars = Math.floor(opts.maxTokens * 3.3);

  // Sort nodes by confidence (highest first), then recency
  const sorted = [...nodes].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updated_at.localeCompare(a.updated_at);
  });

  // Per-type cap: keep the top-N highest-confidence nodes of each type so a
  // single over-represented type (e.g. many near-duplicate decisions) can't
  // crowd out the rest before the char-budget loop even runs.
  const selected = (opts.maxPerType && opts.maxPerType > 0)
    ? (() => {
        const perType = new Map<string, number>();
        return sorted.filter((node) => {
          const n = (perType.get(node.type) ?? 0) + 1;
          perType.set(node.type, n);
          return n <= opts.maxPerType!;
        });
      })()
    : sorted;

  // L4 fix: Build edge lookup for both outgoing and incoming edges per node
  const outEdgeMap = new Map<string, Edge[]>();
  const inEdgeMap = new Map<string, Edge[]>();
  if (opts.includeEdges) {
    for (const edge of edges) {
      const outgoing = outEdgeMap.get(edge.source_id) ?? [];
      outgoing.push(edge);
      outEdgeMap.set(edge.source_id, outgoing);

      const incoming = inEdgeMap.get(edge.target_id) ?? [];
      incoming.push(edge);
      inEdgeMap.set(edge.target_id, incoming);
    }
  }

  // Build node name lookup for edge targets
  const nodeNameMap = new Map<string, string>();
  for (const node of nodes) {
    nodeNameMap.set(node.id, node.name);
  }

  const lines: string[] = [];
  let charCount = 0;

  for (const node of selected) {
    const section = formatNode(
      node,
      outEdgeMap.get(node.id) ?? [],
      inEdgeMap.get(node.id) ?? [],
      nodeNameMap,
      opts,
    );
    const sectionChars = section.length;

    if (charCount + sectionChars > maxChars) {
      // This node's full section doesn't fit. Emit just its header (so the
      // agent knows it exists) if even that fits, then KEEP GOING — a later,
      // smaller node may still fit the remaining budget. Using `break` here was
      // a latent bug: one oversized section (e.g. a hub with many edges, or a
      // very long summary) silently dropped every subsequent node from the
      // response, sometimes collapsing the whole context to a single header.
      const header = `## ${node.name} [${node.type}]`;
      if (charCount + header.length + 20 <= maxChars) {
        lines.push(header);
        lines.push('(truncated)');
        charCount += header.length + 12; // header + '\n\n(truncated)'
      }
      continue;
    }

    lines.push(section);
    charCount += sectionChars;
  }

  return lines.join('\n\n');
}

function formatNode(
  node: Node,
  outEdges: Edge[],
  inEdges: Edge[],
  nodeNameMap: Map<string, string>,
  opts: ContextBuildOptions,
): string {
  const lines: string[] = [];

  const confidence = node.confidence < 1.0 ? ` (conf: ${node.confidence.toFixed(2)})` : '';
  lines.push(`## ${node.name} [${node.type}]${confidence}`);

  if (node.summary) {
    lines.push(node.summary);
  } else if (opts.includeProperties && Object.keys(node.properties).length > 0) {
    for (const [key, value] of Object.entries(node.properties)) {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`${key}: ${valStr}`);
    }
  }

  // Outgoing edges: node -> target (capped; highest-confidence/most-recent kept)
  if (opts.includeEdges && outEdges.length > 0) {
    const sorted = sortEdgesForDisplay(outEdges);
    for (const edge of sorted.slice(0, MAX_EDGES_PER_DIRECTION)) {
      const targetName = nodeNameMap.get(edge.target_id) ?? edge.target_id;
      const edgeConf = edge.confidence < 1.0 ? ` (${edge.confidence.toFixed(2)})` : '';
      lines.push(`-> ${edge.predicate}: ${targetName}${edgeConf}`);
    }
    if (sorted.length > MAX_EDGES_PER_DIRECTION) {
      lines.push(`-> (+${sorted.length - MAX_EDGES_PER_DIRECTION} more)`);
    }
  }

  // L4: Incoming edges: source -> node (capped)
  if (opts.includeEdges && inEdges.length > 0) {
    const sorted = sortEdgesForDisplay(inEdges);
    for (const edge of sorted.slice(0, MAX_EDGES_PER_DIRECTION)) {
      const sourceName = nodeNameMap.get(edge.source_id) ?? edge.source_id;
      const edgeConf = edge.confidence < 1.0 ? ` (${edge.confidence.toFixed(2)})` : '';
      lines.push(`<- ${edge.predicate}: ${sourceName}${edgeConf}`);
    }
    if (sorted.length > MAX_EDGES_PER_DIRECTION) {
      lines.push(`<- (+${sorted.length - MAX_EDGES_PER_DIRECTION} more)`);
    }
  }

  return lines.join('\n');
}

/**
 * Estimates the number of tokens in a string.
 * L2: Uses ~3.3 chars per token (better for structured/JSON-heavy content).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}
