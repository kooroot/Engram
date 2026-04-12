export type EventType = 'observation' | 'action' | 'mutation' | 'query' | 'system';
export type EventSource = 'user' | 'agent' | 'system';

export interface Event {
  id: number;
  timestamp: string;
  type: EventType;
  source: EventSource;
  session_id: string | null;
  content: Record<string, unknown>;
  state_ref: string[] | null;
  checksum: string | null;
}

/** Raw row from SQLite */
export interface EventRow {
  id: number;
  timestamp: string;
  type: string;
  source: string;
  session_id: string | null;
  content: string;
  state_ref: string | null;
  checksum: string | null;
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeParseArray(str: string | null): string[] | null {
  if (!str) return null;
  try {
    return JSON.parse(str) as string[];
  } catch {
    return null;
  }
}

export function eventFromRow(row: EventRow): Event {
  return {
    ...row,
    type: row.type as EventType,
    source: row.source as EventSource,
    content: safeParseJson(row.content),
    state_ref: safeParseArray(row.state_ref),
  };
}
