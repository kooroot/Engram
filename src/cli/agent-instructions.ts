import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENGRAM_START_MARKER = '<!-- engram:start -->';
export const ENGRAM_END_MARKER = '<!-- engram:end -->';

/**
 * Token-conscious instructions added to each AI CLI's global instruction file
 * (CLAUDE.md / AGENTS.md / GEMINI.md). The text is bounded by markers so we
 * can refresh in place without duplicating.
 */
export const ENGRAM_INSTRUCTIONS = `${ENGRAM_START_MARKER}
## Persistent Memory (Engram)

You have access to the \`engram\` MCP server — a local persistent memory graph.

USE engram when:
- The user mentions a person, project, or decision that might already be stored
- The user asks to remember something, or asks what you remember
- You're building context on a topic worked on before

DO NOT use engram for:
- Trivial questions (time, general programming knowledge)
- Pure code questions about the user's CURRENT file (use the file directly)
- Things that won't matter beyond this conversation

Token-conscious order:
1. \`query_engram\` (structured, cheap) BEFORE \`get_context\` (semantic, expensive)
2. Pass \`max_tokens=1500\` to read tools unless you really need more
3. Don't call multiple read tools in parallel for the same query

For writes: \`mutate_state\` proactively, but ONLY for facts worth keeping
across conversations. Use \`link_entities\` for relationships
(e.g. "Alice works on Project X").

The user can audit your token usage with \`engram usage\` (day / week / month).
Be conservative — every read tool call is recorded.
${ENGRAM_END_MARKER}`;

export type ClientId = 'claude' | 'codex' | 'gemini';

export interface InstructionFile {
  clientId: ClientId;
  label: string;
  path: string;
}

export function getInstructionFiles(): InstructionFile[] {
  const home = os.homedir();
  return [
    { clientId: 'claude', label: 'Claude Code (CLAUDE.md)', path: path.join(home, '.claude', 'CLAUDE.md') },
    { clientId: 'codex',  label: 'Codex CLI (AGENTS.md)',   path: path.join(home, '.codex', 'AGENTS.md') },
    { clientId: 'gemini', label: 'Gemini CLI (GEMINI.md)',  path: path.join(home, '.gemini', 'GEMINI.md') },
  ];
}

export type InstallStatus = 'created' | 'appended' | 'updated' | 'unchanged';

export interface InstallResult {
  status: InstallStatus;
  message: string;
}

/**
 * Install (or refresh) the Engram instructions section in the given file.
 * - If the file doesn't exist, creates it with just the section.
 * - If markers already exist, replaces the section in place (idempotent refresh).
 * - Otherwise appends to the end of the existing content.
 */
export function installInstructions(file: InstructionFile): InstallResult {
  const dir = path.dirname(file.path);
  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(file.path);
  const original = existed ? fs.readFileSync(file.path, 'utf8') : '';

  const startIdx = original.indexOf(ENGRAM_START_MARKER);
  const endIdx = original.indexOf(ENGRAM_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = original.slice(0, startIdx);
    const after = original.slice(endIdx + ENGRAM_END_MARKER.length);
    const existingSection = original.slice(startIdx, endIdx + ENGRAM_END_MARKER.length);
    if (existingSection.trim() === ENGRAM_INSTRUCTIONS.trim()) {
      return { status: 'unchanged', message: 'instructions already up to date' };
    }
    const merged = before + ENGRAM_INSTRUCTIONS + after;
    fs.writeFileSync(file.path, merged);
    return { status: 'updated', message: 'Engram section refreshed' };
  }

  // Append (or create)
  let newContent: string;
  if (!existed || original.length === 0) {
    newContent = ENGRAM_INSTRUCTIONS + '\n';
  } else {
    const sep = original.endsWith('\n\n') ? '' : original.endsWith('\n') ? '\n' : '\n\n';
    newContent = original + sep + ENGRAM_INSTRUCTIONS + '\n';
  }
  fs.writeFileSync(file.path, newContent);
  return {
    status: existed ? 'appended' : 'created',
    message: existed ? 'Engram section appended' : 'file created with Engram section',
  };
}

/**
 * Reports for each known instruction file whether it exists and whether the
 * Engram section is currently installed.
 */
export interface InstructionStatus {
  file: InstructionFile;
  exists: boolean;
  hasEngramSection: boolean;
}

export function getInstructionStatuses(): InstructionStatus[] {
  return getInstructionFiles().map(file => {
    const exists = fs.existsSync(file.path);
    if (!exists) return { file, exists: false, hasEngramSection: false };
    const content = fs.readFileSync(file.path, 'utf8');
    return { file, exists: true, hasEngramSection: content.includes(ENGRAM_START_MARKER) };
  });
}
