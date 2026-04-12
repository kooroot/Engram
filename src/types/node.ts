export interface Node {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  summary: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  version: number;
  archived: boolean;
  event_id: number | null;
}

export interface Edge {
  id: string;
  source_id: string;
  predicate: string;
  target_id: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
  updated_at: string;
  version: number;
  archived: boolean;
  event_id: number | null;
}

export interface Triplet {
  subject: Node;
  predicate: string;
  object: Node;
  edge: Edge;
}

/** Raw row from SQLite (properties stored as JSON string) */
export interface NodeRow {
  id: string;
  type: string;
  name: string;
  properties: string;
  summary: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  version: number;
  archived: number;
  event_id: number | null;
}

/** Raw row from SQLite */
export interface EdgeRow {
  id: string;
  source_id: string;
  predicate: string;
  target_id: string;
  properties: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  version: number;
  archived: number;
  event_id: number | null;
}

export function nodeFromRow(row: NodeRow): Node {
  return {
    ...row,
    properties: JSON.parse(row.properties),
    archived: row.archived === 1,
  };
}

export function edgeFromRow(row: EdgeRow): Edge {
  return {
    ...row,
    properties: JSON.parse(row.properties),
    archived: row.archived === 1,
  };
}
