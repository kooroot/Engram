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

export function eventFromRow(row: EventRow): Event {
  return {
    ...row,
    type: row.type as EventType,
    source: row.source as EventSource,
    content: JSON.parse(row.content),
    state_ref: row.state_ref ? JSON.parse(row.state_ref) : null,
  };
}
