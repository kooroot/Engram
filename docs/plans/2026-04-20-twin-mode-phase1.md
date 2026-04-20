# Twin Mode — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the engram-side kernel for Twin Mode — the `engram autosave` command, the extraction schema, and a `--hook-format` flag on `engram context` for direct hook output. Anthropic provider only in this phase.

**Architecture:** New `src/twin/` module isolates the new logic. Autosave reads a transcript, calls Anthropic Haiku, validates output against a strict zod schema, dedups via existing `query_engram` lookups, and emits `mutate_state` calls. No adapter / hook script work in Phase 1 — that's Phase 2.

**Tech Stack:** TypeScript, bun, zod (existing dep), `@anthropic-ai/sdk` (NEW dep), vitest, commander.

**Scope (5 files max):**
1. Create `src/twin/schema.ts`
2. Create `src/twin/providers.ts`
3. Create `src/twin/autosave.ts`
4. Modify `src/cli/index.ts` (add command, add `--hook-format` flag)
5. Create `tests/unit/twin-autosave.test.ts`

---

## Pre-work

### Step 0: Verify clean baseline

Run: `bun run typecheck && bun run test`
Expected: all green. If not, stop and fix before starting.

### Step 1: Add `@anthropic-ai/sdk` dependency

Run: `bun add @anthropic-ai/sdk`
Expected: `package.json` updated, `bun.lock` updated.

Commit: `chore: add @anthropic-ai/sdk for twin-mode autosave`

---

## Task 1 — Extraction schema

**File:** Create `src/twin/schema.ts`

**Step 1.1: Write the failing test**

Create `tests/unit/twin-autosave.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { ExtractionSchema, validateExtraction } from '../../src/twin/schema.js';

describe('twin extraction schema', () => {
  it('accepts a well-formed extraction', () => {
    const valid = {
      items: [
        {
          kind: 'decision',
          name: 'Use bun not npm',
          summary: 'User decided to use bun for all package management',
          properties: { tool: 'bun' },
          confidence: 0.9,
          links: [],
        },
      ],
    };
    expect(() => validateExtraction(valid)).not.toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => validateExtraction({ items: [{ kind: 'decision' }] })).toThrow();
  });

  it('rejects unknown kinds', () => {
    expect(() => validateExtraction({
      items: [{ kind: 'banana', name: 'x', summary: 'y', confidence: 0.5, links: [] }],
    })).toThrow();
  });

  it('accepts empty items array', () => {
    expect(() => validateExtraction({ items: [] })).not.toThrow();
  });
});
```

**Step 1.2: Run test, verify it fails**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: FAIL — `Cannot find module 'src/twin/schema.js'`.

**Step 1.3: Implement schema**

Create `src/twin/schema.ts`:

```typescript
import { z } from 'zod';

export const ExtractionItemKind = z.enum([
  'decision', 'preference', 'fact', 'insight', 'person', 'project_update',
]);

export const ExtractionLink = z.object({
  predicate: z.string().min(1).max(64),
  target_name: z.string().min(1).max(512),
});

export const ExtractionItem = z.object({
  kind: ExtractionItemKind,
  name: z.string().min(1).max(512),
  summary: z.string().min(1).max(2000),
  properties: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
  links: z.array(ExtractionLink),
});

export const ExtractionSchema = z.object({
  items: z.array(ExtractionItem).max(50),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionItemT = z.infer<typeof ExtractionItem>;

export function validateExtraction(input: unknown): Extraction {
  return ExtractionSchema.parse(input);
}
```

**Step 1.4: Run test, verify pass**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: 4 passing.

**Step 1.5: Commit**

```bash
git add src/twin/schema.ts tests/unit/twin-autosave.test.ts
git commit -m "feat(twin): extraction schema for autosave"
```

---

## Task 2 — Anthropic provider

**File:** Create `src/twin/providers.ts`

**Step 2.1: Write the failing test**

Append to `tests/unit/twin-autosave.test.ts`:

```typescript
import { extractWithProvider } from '../../src/twin/providers.js';

describe('twin providers', () => {
  it('returns parsed extraction from a mocked anthropic response', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              items: [{
                kind: 'fact', name: 'Test fact', summary: 'A test',
                confidence: 0.8, links: [],
              }],
            }),
          }],
        }),
      },
    };
    const result = await extractWithProvider({
      provider: 'anthropic',
      transcript: 'user: hello\nassistant: hi',
      client: fakeClient as any,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Test fact');
  });

  it('throws on schema-violating response', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ items: [{ kind: 'banana' }] }) }],
        }),
      },
    };
    await expect(extractWithProvider({
      provider: 'anthropic',
      transcript: 'x',
      client: fakeClient as any,
    })).rejects.toThrow();
  });
});
```

**Step 2.2: Run, verify FAIL**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: FAIL — module not found.

**Step 2.3: Implement provider**

Create `src/twin/providers.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { validateExtraction, type Extraction } from './schema.js';

export type ProviderName = 'anthropic';

const EXTRACTION_PROMPT = `You are an extraction agent for Engram, a persistent memory graph.

Input: a transcript of a recent AI ↔ user session.

Task: extract anything SUBSTANTIVE worth remembering across sessions:
  - decisions (architectural, design, tooling)
  - preferences ("user prefers X", "user dislikes Y")
  - facts about people, projects, systems mentioned
  - non-obvious insights or gotchas discovered
  - project state updates (milestones, blockers)

DO NOT extract:
  - greetings, acknowledgments, simple Q&A
  - the model's own clarifying questions
  - syntax lookups or general programming knowledge
  - anything reversed or abandoned within the same session (only the FINAL state matters)

Output: strict JSON only (no prose, no markdown fences) matching this TypeScript type:
{
  items: Array<{
    kind: 'decision' | 'preference' | 'fact' | 'insight' | 'person' | 'project_update',
    name: string,             // canonical name for dedup
    summary: string,          // 1-2 sentences
    properties?: Record<string, unknown>,
    confidence: number,       // 0.0 - 1.0
    links: Array<{ predicate: string, target_name: string }>
  }>
}

If nothing substantive was discussed, return { "items": [] }.`;

export interface ExtractOptions {
  provider: ProviderName;
  transcript: string;
  apiKey?: string;
  client?: Anthropic;  // injected for tests
  model?: string;
}

export async function extractWithProvider(opts: ExtractOptions): Promise<Extraction> {
  if (opts.provider !== 'anthropic') {
    throw new Error(`Provider not yet implemented: ${opts.provider}`);
  }
  const client = opts.client
    ?? new Anthropic({ apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] });

  const resp = await client.messages.create({
    model: opts.model ?? 'claude-haiku-4-5',
    max_tokens: 2000,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: opts.transcript }],
  });

  const block = resp.content.find((b: { type: string }) => b.type === 'text') as
    | { type: 'text'; text: string } | undefined;
  if (!block) throw new Error('Provider returned no text content');

  const cleaned = block.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(cleaned);
  return validateExtraction(parsed);
}
```

**Step 2.4: Run, verify pass**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: all passing (6 tests).

**Step 2.5: Commit**

```bash
git add src/twin/providers.ts tests/unit/twin-autosave.test.ts
git commit -m "feat(twin): anthropic provider for autosave extraction"
```

---

## Task 3 — Autosave orchestrator

**File:** Create `src/twin/autosave.ts`

**Step 3.1: Write the failing test**

Append to `tests/unit/twin-autosave.test.ts`:

```typescript
import { runAutosave } from '../../src/twin/autosave.js';
import { createEngramCore } from '../../src/service.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAutosave', () => {
  let tmpDir: string;
  let core: ReturnType<typeof createEngramCore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engram-twin-'));
    process.env['ENGRAM_DATA_DIR'] = tmpDir;
    core = createEngramCore({ namespace: 'test' });
  });

  afterEach(async () => {
    await core.closeAsync();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ENGRAM_DATA_DIR'];
  });

  it('creates new nodes from extraction', async () => {
    const transcriptPath = join(tmpDir, 'transcript.txt');
    writeFileSync(transcriptPath, 'user: I prefer tabs over spaces\nassistant: noted');

    const fakeExtract = async () => ({
      items: [{
        kind: 'preference' as const,
        name: 'Tabs over spaces',
        summary: 'User prefers tabs',
        confidence: 0.95,
        links: [],
      }],
    });

    const report = await runAutosave({
      core,
      transcriptPath,
      provider: 'anthropic',
      extractFn: fakeExtract,
    });

    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
  });

  it('skips when extraction returns empty items', async () => {
    const transcriptPath = join(tmpDir, 'transcript.txt');
    writeFileSync(transcriptPath, 'user: hi\nassistant: hello');

    const report = await runAutosave({
      core,
      transcriptPath,
      provider: 'anthropic',
      extractFn: async () => ({ items: [] }),
    });

    expect(report.created).toBe(0);
  });

  it('updates existing node instead of duplicating', async () => {
    const transcriptPath = join(tmpDir, 'transcript.txt');
    writeFileSync(transcriptPath, 'something');

    const item = {
      kind: 'preference' as const,
      name: 'Use bun',
      summary: 'first save',
      confidence: 0.8,
      links: [],
    };

    await runAutosave({ core, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({ items: [item] }) });

    const report = await runAutosave({ core, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({ items: [{ ...item, summary: 'updated save' }] }) });

    expect(report.updated).toBe(1);
    expect(report.created).toBe(0);
  });
});
```

**Step 3.2: Run, verify FAIL**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: FAIL — module not found.

**Step 3.3: Implement autosave**

Create `src/twin/autosave.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import type { EngramCore } from '../service.js';
import { extractWithProvider, type ProviderName } from './providers.js';
import type { Extraction, ExtractionItemT } from './schema.js';

export interface AutosaveReport {
  created: number;
  updated: number;
  skipped: number;
  linksCreated: number;
  errors: string[];
}

export interface RunAutosaveOpts {
  core: EngramCore;
  transcriptPath: string;
  provider: ProviderName;
  apiKey?: string;
  model?: string;
  /** For tests: skip the LLM call and inject extraction directly. */
  extractFn?: (transcript: string) => Promise<Extraction>;
  minTranscriptBytes?: number;
}

const KIND_TO_NODE_TYPE: Record<ExtractionItemT['kind'], string> = {
  decision: 'decision',
  preference: 'preference',
  fact: 'fact',
  insight: 'insight',
  person: 'person',
  project_update: 'project',
};

export async function runAutosave(opts: RunAutosaveOpts): Promise<AutosaveReport> {
  const report: AutosaveReport = {
    created: 0, updated: 0, skipped: 0, linksCreated: 0, errors: [],
  };

  const stat = statSync(opts.transcriptPath);
  const minBytes = opts.minTranscriptBytes ?? 200;
  if (stat.size < minBytes) {
    report.skipped = 1;
    return report;
  }

  const transcript = readFileSync(opts.transcriptPath, 'utf8');
  const extraction = opts.extractFn
    ? await opts.extractFn(transcript)
    : await extractWithProvider({
        provider: opts.provider,
        transcript,
        apiKey: opts.apiKey,
        model: opts.model,
      });

  if (extraction.items.length === 0) return report;

  for (const item of extraction.items) {
    try {
      const nodeType = KIND_TO_NODE_TYPE[item.kind];
      const existing = opts.core.stateTree.getNodeByName(item.name);

      let nodeId: string;
      if (existing) {
        opts.core.stateTree.updateNode(existing.id, {
          summary: item.summary,
          properties: { ...(existing.properties ?? {}), ...(item.properties ?? {}) },
          confidence: item.confidence,
        });
        nodeId = existing.id;
        report.updated += 1;
      } else {
        nodeId = opts.core.stateTree.createNode({
          type: nodeType,
          name: item.name,
          summary: item.summary,
          properties: item.properties ?? {},
          confidence: item.confidence,
        });
        report.created += 1;
      }

      for (const link of item.links) {
        const target = opts.core.stateTree.getNodeByName(link.target_name);
        if (!target) continue;
        opts.core.stateTree.createEdge({
          source_id: nodeId,
          target_id: target.id,
          predicate: link.predicate,
          confidence: item.confidence,
        });
        report.linksCreated += 1;
      }
    } catch (err) {
      report.errors.push(`${item.name}: ${(err as Error).message}`);
    }
  }

  return report;
}
```

> ⚠️ The exact `stateTree` method names (`getNodeByName`, `updateNode`, `createNode`, `createEdge`) need verification against `src/db/state-tree.ts` before this compiles. Read the file first and adjust the calls.

**Step 3.4: Verify state-tree API**

Run: `bun run typecheck`
If errors → read `src/db/state-tree.ts` and fix method names / signatures. Adjust autosave.ts.

**Step 3.5: Run tests, verify pass**

Run: `bun run test tests/unit/twin-autosave.test.ts`
Expected: all 9 passing.

**Step 3.6: Commit**

```bash
git add src/twin/autosave.ts tests/unit/twin-autosave.test.ts
git commit -m "feat(twin): autosave orchestrator with dedup"
```

---

## Task 4 — CLI wiring

**Files:** Modify `src/cli/index.ts`

**Step 4.1: Add `--hook-format` flag to existing `engram context`**

Find the `context` command block (lines ~257-276). Add a new option and branch:

```typescript
.option('--hook-format <event>', 'Wrap output as Claude Code hook JSON (event: SessionStart|UserPromptSubmit)')
```

In the action body, after `const context = await svc.getContext(...)`, change the output:

```typescript
if (opts.hookFormat) {
  if (!context || context.includes('No relevant context')) {
    process.exit(0); // empty → hook skips injection
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: opts.hookFormat,
      additionalContext: `[Engram Memory] Relevant context for "${topic}":\n\n${context}`,
    },
  };
  console.log(JSON.stringify(out));
} else {
  console.log(context);
}
```

**Step 4.2: Add `engram autosave <transcript>` command**

After the `context` command block, insert:

```typescript
// ─── autosave (twin mode) ───────────────────────
program
  .command('autosave <transcript>')
  .description('Extract substance from a session transcript and save to memory (twin mode)')
  .option('-p, --provider <name>', 'LLM provider', 'anthropic')
  .option('-m, --model <name>', 'Override default model')
  .option('--min-bytes <n>', 'Skip if transcript smaller than this', '200')
  .option('--dry-run', 'Print extraction without saving')
  .action((transcript: string, opts: {
    provider: string; model?: string; minBytes: string; dryRun?: boolean;
  }) => withCore(async (core) => {
    const { runAutosave } = await import('../twin/autosave.js');
    try {
      const report = await runAutosave({
        core,
        transcriptPath: transcript,
        provider: opts.provider as 'anthropic',
        model: opts.model,
        minTranscriptBytes: safeInt(opts.minBytes, 200),
      });
      // Print summary to stderr so hooks can stay quiet on stdout
      process.stderr.write(
        `[engram] autosave: ${report.created} created, ${report.updated} updated, ` +
        `${report.skipped} skipped, ${report.linksCreated} links` +
        (report.errors.length ? `, ${report.errors.length} errors` : '') + '\n',
      );
      if (report.errors.length) {
        for (const e of report.errors) process.stderr.write(`  error: ${e}\n`);
      }
    } catch (err) {
      process.stderr.write(`[engram] autosave failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }, ns())());
```

**Step 4.3: Verify**

Run: `bun run typecheck`
Expected: no errors.

Run: `bun run test`
Expected: all passing.

Manual smoke test:

```bash
# Create a fake transcript
echo "user: I just decided we're going with bun for all package management.
assistant: Saved that as a preference." > /tmp/fake-transcript.txt

# Dry-run with no API key — should fail gracefully
ANTHROPIC_API_KEY=invalid bun run dev autosave /tmp/fake-transcript.txt 2>&1 | head -5

# Hook-format on context
bun run dev context "twin mode" --hook-format UserPromptSubmit
```

Expected: autosave shows clean error message; context emits valid hook JSON.

**Step 4.4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(twin): cli — autosave command + --hook-format flag"
```

---

## Task 5 — End-to-end real-API smoke (manual, optional)

If the user has `ANTHROPIC_API_KEY` set:

```bash
# Use this very session's twin design discussion as transcript
git log --since="2 hours ago" --pretty=format:"%s%n%b" > /tmp/engram-twin-transcript.txt
bun run dev autosave /tmp/engram-twin-transcript.txt
bun run dev query "Engram Twin Mode"
```

Expected: at least 1 node created or updated; query returns the project node with updated summary.

**Do not commit anything from this step.** It's a verification-only run.

---

## Verification gate (before declaring Phase 1 done)

- [ ] `bun run typecheck` → 0 errors
- [ ] `bun run test` → all passing (existing + 9 new)
- [ ] `bun run build` → succeeds
- [ ] Manual smoke (Step 4.3) → both commands behave
- [ ] `git log --oneline` shows 4 clean Phase 1 commits

If any fail, do NOT proceed to Phase 2. Fix and re-verify.

---

## Out of scope (deferred to later phases)

- Hook scripts (Phase 2: Claude Code adapter)
- OpenAI / Google providers (Phase 3)
- Codex CLI / Gemini CLI adapters (Phase 4–5)
- Config file (`~/.engram/config.json` twin section) — for now CLI flags only
- Cost telemetry, daily caps — Phase 6
