-- Per-tool-call usage tracking. Survives restarts; aggregated by `engram usage`.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                              -- unix epoch ms (when the call completed)
  namespace TEXT NOT NULL DEFAULT 'default',
  tool TEXT NOT NULL,                               -- mcp tool name (e.g. 'get_context')
  input_chars INTEGER NOT NULL DEFAULT 0,           -- size of stringified input args
  output_chars INTEGER NOT NULL DEFAULT 0,          -- size of stringified response text content
  est_tokens INTEGER NOT NULL DEFAULT 0,            -- ceil((input + output) / 3.3) -- same estimator as context-builder.ts
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1                     -- 1 if handler resolved, 0 if it threw
);

CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_log_ns_ts ON usage_log(namespace, ts);
CREATE INDEX IF NOT EXISTS idx_usage_log_tool_ts ON usage_log(tool, ts);
