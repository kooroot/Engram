/**
 * Structured JSON logger. Writes to stderr so MCP stdio protocol (on stdout) isn't polluted.
 * ENGRAM_LOG_LEVEL controls verbosity. ENGRAM_LOG_FORMAT=pretty for human-readable.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

const envLevel = (process.env['ENGRAM_LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel;
const format = process.env['ENGRAM_LOG_FORMAT'] ?? 'json';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[envLevel] ?? 20);
}

function write(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };

  if (format === 'pretty') {
    const color = level === 'error' ? '\x1b[31m'
      : level === 'warn' ? '\x1b[33m'
      : level === 'debug' ? '\x1b[90m'
      : '\x1b[36m';
    const reset = '\x1b[0m';
    const rest = Object.entries(fields).length > 0
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      : '';
    process.stderr.write(`${color}${level.toUpperCase()}${reset} ${msg}${rest}\n`);
  } else {
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}

export const log = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => write('debug', msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => write('info', msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => write('warn', msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => write('error', msg, fields),
  child: (baseFields: Record<string, unknown>) => ({
    debug: (msg: string, f: Record<string, unknown> = {}) => write('debug', msg, { ...baseFields, ...f }),
    info: (msg: string, f: Record<string, unknown> = {}) => write('info', msg, { ...baseFields, ...f }),
    warn: (msg: string, f: Record<string, unknown> = {}) => write('warn', msg, { ...baseFields, ...f }),
    error: (msg: string, f: Record<string, unknown> = {}) => write('error', msg, { ...baseFields, ...f }),
  }),
};

/** Generate a short request ID */
export function newRequestId(): string {
  return Math.random().toString(36).substring(2, 10);
}
