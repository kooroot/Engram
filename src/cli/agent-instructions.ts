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
 * Philosophy: Engram is the AI's long-term WORKING JOURNAL, not a
 * dictation pad. It captures the substance of ongoing work by default
 * so the next session can resume. Project identity is anchored to the
 * current working directory.
 */
export const ENGRAM_INSTRUCTIONS = `${ENGRAM_START_MARKER}
## Persistent Memory (Engram) — your long-term working journal

You have access to \`engram\`, a persistent memory graph that survives
across sessions. Treat it as your WORKING JOURNAL: write continuously
as we work so the next session remembers what we were doing.

### AT SESSION START

1. Detect the user's PROJECT context from the current working directory,
   explicit mention, or recurring file paths.
2. Call \`query_engram\` by project name or cwd. If a project node
   exists, open with a one-line "where we left off" summary from its
   \`summary\` field before asking the user for new input.
3. If no project node exists but the user is actively working in a
   directory, CREATE one:
   - type: \`project\`
   - name: short human-readable title (e.g. "Upbit SDK")
   - properties: \`{ cwd: "/absolute/path" }\` plus language/stack if clear
   - summary: 1–2 sentences on what it is and current state

### WRITE CONTINUOUSLY (no "remember" needed) when the user:

1. Starts/describes a PROJECT or TOPIC — create/update project node;
   the \`summary\` field is a RUNNING NARRATIVE of state + next steps.
2. Makes a DECISION or DESIGN CHOICE — create \`decision\` node with the
   WHY; \`link_entities\` with predicate \`decided_in\` → project.
3. DISCOVERS an INSIGHT or GOTCHA — create \`insight\`/\`fact\` node;
   link \`discovered_in\` → project.
4. Announces PROGRESS (completed/started something) — UPDATE the project
   node's \`summary\`, don't create a new node.
5. Shares a PREFERENCE, OPINION, or VALUE STATEMENT — save as
   \`preference\` node; link to a \`self\` or \`user\` node if present.
6. Introduces PEOPLE / TEAMS / EXTERNAL ENTITIES by name + role — create
   nodes and \`link_entities\` for relationships (works_on, reports_to, etc.)
7. Explicitly asks to REMEMBER — obvious case.

### PREFER UPDATE OVER DUPLICATE

Before creating a node, \`query_engram\` by \`node_name\` + \`node_type\`.
One project node per project — its summary evolves across sessions.
One decision node per decision — update if the decision changes.

### DO NOT save

- Trivial Q&A (time, syntax lookups, general programming knowledge)
- Your own prose when the user didn't introduce anything new
- Intermediate debugging of the CURRENT file (the code is authoritative)
- Ephemeral filler ("ok", "thanks", "got it")

### TOKEN DISCIPLINE

- \`query_engram\` (cheap, structured) before \`get_context\` (expensive).
- Pass \`max_tokens=1500\` on reads unless you really need more.
- Writes are CHEAP compared to losing next-session context. Over-saving
  substance is far less bad than forgetting it.

The user audits via \`engram usage\`. Save the substance, skip the fluff.
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
