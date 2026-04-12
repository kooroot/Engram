import type { Node, Edge } from '../types/index.js';

export interface ContextBuildOptions {
  maxTokens: number;
  includeProperties: boolean;
  includeEdges: boolean;
}

const DEFAULT_OPTIONS: ContextBuildOptions = {
  maxTokens: 2000,
  includeProperties: true,
  includeEdges: true,
};

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

  for (const node of sorted) {
    const section = formatNode(
      node,
      outEdgeMap.get(node.id) ?? [],
      inEdgeMap.get(node.id) ?? [],
      nodeNameMap,
      opts,
    );
    const sectionChars = section.length;

    if (charCount + sectionChars > maxChars) {
      // Try to fit at least the header
      const header = `## ${node.name} [${node.type}]`;
      if (charCount + header.length + 20 <= maxChars) {
        lines.push(header);
        lines.push('(truncated)');
      }
      break;
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

  // Outgoing edges: node -> target
  if (opts.includeEdges && outEdges.length > 0) {
    for (const edge of outEdges) {
      const targetName = nodeNameMap.get(edge.target_id) ?? edge.target_id;
      const edgeConf = edge.confidence < 1.0 ? ` (${edge.confidence.toFixed(2)})` : '';
      lines.push(`-> ${edge.predicate}: ${targetName}${edgeConf}`);
    }
  }

  // L4: Incoming edges: source -> node
  if (opts.includeEdges && inEdges.length > 0) {
    for (const edge of inEdges) {
      const sourceName = nodeNameMap.get(edge.source_id) ?? edge.source_id;
      const edgeConf = edge.confidence < 1.0 ? ` (${edge.confidence.toFixed(2)})` : '';
      lines.push(`<- ${edge.predicate}: ${sourceName}${edgeConf}`);
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
