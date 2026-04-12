import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventLog } from '../db/event-log.js';

export function registerLogEvent(server: McpServer, eventLog: EventLog): void {
  server.registerTool('log_event', {
    description: 'Append an event to the immutable event log. Use for recording observations, actions, or system events.',
    inputSchema: {
      type: z.enum(['observation', 'action', 'mutation', 'query', 'system']).describe('Event type'),
      source: z.enum(['user', 'agent', 'system']).default('agent').describe('Event source'),
      session_id: z.string().optional().describe('Session identifier to group related events'),
      content: z.record(z.unknown()).describe('Event payload as JSON object'),
    },
  }, async ({ type, source, session_id, content }) => {
    const event = eventLog.append({ type, source, session_id, content });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ event_id: event.id, timestamp: event.timestamp }),
      }],
    };
  });
}
