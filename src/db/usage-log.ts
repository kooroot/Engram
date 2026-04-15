import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface UsageRecord {
  ts: number;
  namespace: string;
  tool: string;
  inputChars: number;
  outputChars: number;
  estTokens: number;
  durationMs: number;
  ok: boolean;
}

export interface UsageTotals {
  calls: number;
  tokens: number;
  durationMs: number;
}

export interface UsageByTool {
  tool: string;
  calls: number;
  tokens: number;
  durationMs: number;
}

export interface UsageByDay {
  day: string;       // YYYY-MM-DD (local time)
  calls: number;
  tokens: number;
}

export interface UsageByNamespace {
  namespace: string;
  calls: number;
  tokens: number;
}

const TOKENS_PER_CHAR = 1 / 3.3;

export class UsageLog {
  private insertStmt: Database.Statement;
  private totalsStmt: Database.Statement;
  private totalsNsStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO usage_log (ts, namespace, tool, input_chars, output_chars, est_tokens, duration_ms, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.totalsStmt = db.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(est_tokens), 0) AS tokens,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_log WHERE ts >= ?
    `);
    this.totalsNsStmt = db.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(est_tokens), 0) AS tokens,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_log WHERE ts >= ? AND namespace = ?
    `);
  }

  record(r: UsageRecord): void {
    try {
      this.insertStmt.run(
        r.ts, r.namespace, r.tool,
        r.inputChars, r.outputChars, r.estTokens, r.durationMs,
        r.ok ? 1 : 0,
      );
    } catch {
      // Never let usage tracking break a tool call.
    }
  }

  totals(sinceMs: number, namespace?: string): UsageTotals {
    const row = (namespace
      ? this.totalsNsStmt.get(sinceMs, namespace)
      : this.totalsStmt.get(sinceMs)) as { calls: number; tokens: number; duration_ms: number };
    return { calls: row.calls, tokens: row.tokens, durationMs: row.duration_ms };
  }

  byTool(sinceMs: number, namespace?: string): UsageByTool[] {
    const sql = namespace
      ? `SELECT tool, COUNT(*) AS calls, COALESCE(SUM(est_tokens),0) AS tokens, COALESCE(SUM(duration_ms),0) AS duration_ms
         FROM usage_log WHERE ts >= ? AND namespace = ? GROUP BY tool ORDER BY tokens DESC`
      : `SELECT tool, COUNT(*) AS calls, COALESCE(SUM(est_tokens),0) AS tokens, COALESCE(SUM(duration_ms),0) AS duration_ms
         FROM usage_log WHERE ts >= ? GROUP BY tool ORDER BY tokens DESC`;
    const rows = (namespace
      ? this.db.prepare(sql).all(sinceMs, namespace)
      : this.db.prepare(sql).all(sinceMs)) as Array<{ tool: string; calls: number; tokens: number; duration_ms: number }>;
    return rows.map(r => ({ tool: r.tool, calls: r.calls, tokens: r.tokens, durationMs: r.duration_ms }));
  }

  byDay(sinceMs: number, namespace?: string): UsageByDay[] {
    const sql = namespace
      ? `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS calls, COALESCE(SUM(est_tokens),0) AS tokens
         FROM usage_log WHERE ts >= ? AND namespace = ?
         GROUP BY day ORDER BY day DESC`
      : `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS calls, COALESCE(SUM(est_tokens),0) AS tokens
         FROM usage_log WHERE ts >= ?
         GROUP BY day ORDER BY day DESC`;
    return (namespace
      ? this.db.prepare(sql).all(sinceMs, namespace)
      : this.db.prepare(sql).all(sinceMs)) as UsageByDay[];
  }

  byNamespace(sinceMs: number): UsageByNamespace[] {
    const sql = `SELECT namespace, COUNT(*) AS calls, COALESCE(SUM(est_tokens),0) AS tokens
                 FROM usage_log WHERE ts >= ?
                 GROUP BY namespace ORDER BY tokens DESC`;
    return this.db.prepare(sql).all(sinceMs) as UsageByNamespace[];
  }

  /**
   * Lightweight per-row fetch for client-side analytics
   * (sessions, streaks, heatmap, etc.). Keep payload narrow.
   */
  rangeRecords(sinceMs: number, namespace?: string): Array<{ ts: number; tool: string; estTokens: number; durationMs: number }> {
    const sql = namespace
      ? `SELECT ts, tool, est_tokens AS estTokens, duration_ms AS durationMs
         FROM usage_log WHERE ts >= ? AND namespace = ? ORDER BY ts ASC`
      : `SELECT ts, tool, est_tokens AS estTokens, duration_ms AS durationMs
         FROM usage_log WHERE ts >= ? ORDER BY ts ASC`;
    return (namespace
      ? this.db.prepare(sql).all(sinceMs, namespace)
      : this.db.prepare(sql).all(sinceMs)) as Array<{ ts: number; tool: string; estTokens: number; durationMs: number }>;
  }

  /** Periodically prune entries older than the retention window (default 90d). */
  prune(retentionDays: number = 90): number {
    const cutoff = Date.now() - retentionDays * 86400 * 1000;
    const result = this.db.prepare('DELETE FROM usage_log WHERE ts < ?').run(cutoff);
    return result.changes;
  }
}

/**
 * Wrap an MCP server with a Proxy that records token usage on every tool call.
 * Tools themselves are unchanged — the Proxy intercepts at registerTool() and
 * augments the handler.
 */
export function withUsageTracking(
  server: McpServer,
  recordFn: (rec: UsageRecord) => void,
  namespace: string,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return function (name: string, schema: unknown, handler: (input: unknown) => Promise<unknown>) {
          const wrapped = async (input: unknown) => {
            const start = Date.now();
            const inputChars = safeStringify(input).length;
            try {
              const result = await handler(input);
              const outputChars = estimateOutputChars(result);
              recordFn({
                ts: Date.now(),
                namespace,
                tool: name,
                inputChars,
                outputChars,
                estTokens: Math.ceil((inputChars + outputChars) * TOKENS_PER_CHAR),
                durationMs: Date.now() - start,
                ok: true,
              });
              return result;
            } catch (err) {
              recordFn({
                ts: Date.now(),
                namespace,
                tool: name,
                inputChars,
                outputChars: 0,
                estTokens: Math.ceil(inputChars * TOKENS_PER_CHAR),
                durationMs: Date.now() - start,
                ok: false,
              });
              throw err;
            }
          };
          // Forward to the original implementation, preserving binding.
          return (target as unknown as { registerTool: (n: string, s: unknown, h: typeof wrapped) => unknown })
            .registerTool.call(target, name, schema, wrapped);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as McpServer;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

/** Sum of `text` fields across MCP tool result `content[]` array. */
function estimateOutputChars(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(r.content)) return safeStringify(result).length;
  let total = 0;
  for (const c of r.content) {
    if (typeof c.text === 'string') total += c.text.length;
  }
  return total;
}
