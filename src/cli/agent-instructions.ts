import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENGRAM_START_MARKER = '<!-- engram:start -->';
export const ENGRAM_END_MARKER = '<!-- engram:end -->';

/**
 * Instructions added to each AI CLI's global instruction file
 * (CLAUDE.md / AGENTS.md / GEMINI.md). Marker-bounded so re-running
 * \`engram onboard\` refreshes in place without duplicating.
 *
 * Philosophy: Engram is the AI's working journal, not a dictation pad.
 * The user should NEVER have to consciously frame work as "this is a
 * project" — the AI itself recognizes substantive work and captures it.
 * Default behavior is WRITE; skipping is the exception.
 */
export const ENGRAM_INSTRUCTIONS = `${ENGRAM_START_MARKER}
## Persistent Memory (Engram) — your long-term working journal

You have access to \`engram\`, a persistent memory graph that survives
across sessions. Treat it as YOUR working journal: capture substance
proactively so the next session resumes without losing context.

The user should NOT have to say "remember this" or frame things as
"a project". YOU recognize the work and capture it.

### AT SESSION START — MANDATORY

1. Detect PROJECT context from cwd, file paths, or what the user is
   discussing.
2. Call \`query_engram\` by project name or cwd basename. If a project
   node exists, open with a one-line "where we left off" summary from
   its \`summary\` field.
3. If no project node and the user is asking you to do real work
   (build, design, debug, implement, plan, research, write), CREATE a
   project node IMMEDIATELY at the start of your work — don't wait for
   the user to "frame" it:
   - type: \`project\`
   - name: short human-readable title (e.g. "Bloomberg Dashboard Prototype")
   - properties: \`{ cwd, stack, theme, ... whatever describes the work }\`
   - summary: 1–2 sentences on what it is + current state

### WRITE PROACTIVELY — your DEFAULT is to capture

USER triggers (obvious):
- Starts/describes a project, topic, or task
- Makes a decision or design choice
- Shares a preference, opinion, or value statement
- Introduces a person, team, or external entity by name
- Explicitly asks to remember

YOUR-OWN-WORK triggers (this is the part you must internalize):
- You make a meaningful design decision while working (color, font,
  layout, library, framework, architecture, data structure, API shape)
  → save as \`decision\` linked to project (\`decided_in\`)
- You discover a non-obvious gotcha or insight while working
  ("turns out X requires Y", "the fix is Z")
  → save as \`insight\`/\`fact\` linked to project (\`discovered_in\`)
- You complete a substantive milestone (auth done, scaffold ready,
  bug fixed, prototype built)
  → UPDATE project.summary to reflect new state, don't fork

ANY user request to BUILD / CREATE / MAKE / DESIGN / IMPLEMENT / WRITE
counts as project work — create a project node first, then save your
ongoing decisions and insights to it.

### DO NOT save

- Pure trivia (time, syntax lookups, general programming knowledge)
- Filler acknowledgments ("ok", "thanks", "got it")
- Your own clarifying questions back to the user
- Read-only inspection of the CURRENT file (the code is authoritative)

### PREFER UPDATE OVER DUPLICATE

Before creating, \`query_engram\` by \`node_name\` + \`node_type\`. One
project node per project — its \`summary\` is a RUNNING NARRATIVE that
evolves across sessions. One decision node per decision — update in
place if it changes. Never fork (no v2 nodes).

### TOKEN DISCIPLINE

- \`query_engram\` (cheap, structured) before \`get_context\` (expensive)
- Pass \`max_tokens=1500\` on reads unless you really need more
- Writes average ~170 tokens — cheap insurance against losing context.
  Over-saving substance is far less bad than forgetting it next session.

The user audits via \`engram usage\` and prunes via \`engram maintenance\`.
They WANT proactive capture. Default action: SAVE.
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
