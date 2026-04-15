import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Parses a shell-style env file (lines like `export FOO=bar` or `FOO=bar`)
 * and applies entries to `process.env`. Existing process.env entries are NEVER
 * overwritten — explicit env always wins over file. Lines starting with `#`
 * and blank lines are ignored. Single- or double-quoted values are unquoted.
 *
 * Returns the list of keys actually set (not the ones skipped).
 */
export function loadEnvFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    set.push(key);
  }
  return set;
}

/**
 * Loads engram.env from the conventional locations (in order):
 *   1. `<dataDir>/engram.env` if `dataDir` is provided or `ENGRAM_DATA_DIR` is set
 *   2. `~/.engram/engram.env` (the onboard default)
 *
 * Skipped entirely if `ENGRAM_NO_ENV_FILE=1`.
 */
export function autoLoadEngramEnv(dataDir?: string): void {
  if (process.env['ENGRAM_NO_ENV_FILE'] === '1') return;
  const seen = new Set<string>();
  const candidates: string[] = [];
  const explicitDataDir = dataDir ?? process.env['ENGRAM_DATA_DIR'];
  if (explicitDataDir) candidates.push(path.join(explicitDataDir, 'engram.env'));
  candidates.push(path.join(os.homedir(), '.engram', 'engram.env'));
  for (const p of candidates) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    loadEnvFile(abs);
  }
}
