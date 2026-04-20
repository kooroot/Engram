import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExtraction, type Extraction } from './schema.js';

export type ProviderName = 'anthropic' | 'claude-cli' | 'codex-cli' | 'gemini-cli';

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
    name: string,
    summary: string,
    properties?: Record<string, unknown>,
    confidence: number,
    links: Array<{ predicate: string, target_name: string }>
  }>
}

If nothing substantive was discussed, return { "items": [] }.`;

/**
 * Hand-written JSON Schema for the `claude --json-schema` flag. Mirrors the
 * Extraction shape — `additionalProperties: false` at every level matches
 * Zod's `.strict()` so model output approved by Claude can't surprise the
 * downstream `validateExtraction()` step. The `properties` field is the one
 * exception because it's user-defined free-form metadata.
 */
const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['decision', 'preference', 'fact', 'insight', 'person', 'project_update'] },
          name: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
          properties: { type: 'object', additionalProperties: true },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          links: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                predicate: { type: 'string', minLength: 1 },
                target_name: { type: 'string', minLength: 1 },
              },
              required: ['predicate', 'target_name'],
            },
          },
        },
        required: ['kind', 'name', 'summary', 'confidence', 'links'],
      },
    },
  },
  required: ['items'],
} as const;

export interface ExtractOptions {
  provider: ProviderName;
  transcript: string;
  apiKey?: string;
  client?: Anthropic;
  model?: string;
  /**
   * Test seam for the claude-cli provider. Replace `spawnSync` so the test
   * never invokes the real CLI binary.
   */
  spawnFn?: SpawnFn;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  /** Bytes piped to the child's stdin (used for the transcript). */
  input?: string,
) => { stdout: string; stderr: string; status: number | null };

/**
 * Error thrown when the provider returned text but it could not be parsed
 * or did not match the schema. Carries a snippet of the raw response so the
 * caller can log it for debugging — without this the failure is opaque.
 */
export class ExtractionParseError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExtractionParseError';
  }
}

const RAW_SNIPPET_BYTES = 500;

function snippet(text: string): string {
  return text.length <= RAW_SNIPPET_BYTES
    ? text
    : text.slice(0, RAW_SNIPPET_BYTES) + `… (truncated, total ${text.length} chars)`;
}

export async function extractWithProvider(opts: ExtractOptions): Promise<Extraction> {
  if (opts.provider === 'anthropic') {
    return extractAnthropic(opts);
  }
  if (opts.provider === 'claude-cli') {
    return Promise.resolve(extractClaudeCli({
      transcript: opts.transcript,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
    }));
  }
  if (opts.provider === 'codex-cli') {
    return Promise.resolve(extractCodexCli({
      transcript: opts.transcript,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
    }));
  }
  if (opts.provider === 'gemini-cli') {
    return Promise.resolve(extractGeminiCli({
      transcript: opts.transcript,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
    }));
  }
  throw new Error(`Provider not yet implemented: ${opts.provider as string}`);
}

export interface ExtractAnthropicOptions {
  transcript: string;
  apiKey?: string;
  client?: Anthropic;
  model?: string;
}

export async function extractAnthropic(opts: ExtractAnthropicOptions): Promise<Extraction> {
  const client = opts.client
    ?? new Anthropic({ apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] });

  const resp = await client.messages.create({
    model: opts.model ?? 'claude-haiku-4-5',
    max_tokens: 4000,
    temperature: 0,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: opts.transcript }],
  });

  const block = resp.content.find((b: { type: string }) => b.type === 'text') as
    | { type: 'text'; text: string } | undefined;
  if (!block) throw new Error('Provider returned no text content');

  // Strip optional opening fence (```json, ```javascript, or bare ```) and closing fence.
  const cleaned = block.text
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ExtractionParseError(
      `JSON.parse failed: ${(err as Error).message}. Raw: ${snippet(block.text)}`,
      block.text, err,
    );
  }
  try {
    return validateExtraction(parsed);
  } catch (err) {
    throw new ExtractionParseError(
      `Schema validation failed: ${(err as Error).message}. Raw: ${snippet(block.text)}`,
      block.text, err,
    );
  }
}

export interface ExtractClaudeCliOptions {
  transcript: string;
  model?: string;
  /** Test seam: replace the real `spawnSync` invocation. */
  spawnFn?: SpawnFn;
}

/**
 * Extract via the `claude` CLI in headless mode. This leverages the user's
 * already-logged-in Claude Code session (subscription auth), so no
 * `ANTHROPIC_API_KEY` is required.
 *
 * Synchronous because `spawnSync` is sync — the dispatcher in
 * `extractWithProvider` wraps the result in a Promise to keep the async
 * surface uniform.
 *
 * NOTE: Do NOT use `--bare`. Per the Claude Code docs, that flag breaks
 * subscription auth and the CLI returns "Not logged in".
 */
export function extractClaudeCli(opts: ExtractClaudeCliOptions): Extraction {
  // Transcript goes via stdin, not argv. macOS ARG_MAX is ~256KB so passing
  // a large transcript as a positional arg fails with E2BIG when users raise
  // --max-bytes. Stdin has no such limit. The -p arg is the user message;
  // the transcript content is what the model analyzes.
  const args = [
    '--print',
    '--model', opts.model ?? 'claude-haiku-4-5',
    '--system-prompt', EXTRACTION_PROMPT,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(EXTRACTION_JSON_SCHEMA),
    'Extract substance from the transcript piped on stdin.',
  ];

  const fn: SpawnFn = opts.spawnFn ?? ((cmd, a, input) => {
    // Scrub ANTHROPIC_API_KEY so the claude CLI uses subscription auth, not
    // metered API auth. Without this, users with both auth modes would get
    // surprise API charges. They can still force API auth by passing
    // --provider anthropic.
    const childEnv = { ...process.env };
    delete childEnv['ANTHROPIC_API_KEY'];
    const r = spawnSync(cmd, a, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv,
      ...(input !== undefined ? { input } : {}),
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status,
    };
  });

  const result = fn('claude', args, opts.transcript);

  if (result.status !== 0) {
    throw new ExtractionParseError(
      `claude CLI exited ${result.status}: ${result.stderr.slice(0, 500)}`,
      result.stdout,
      undefined,
    );
  }

  let envelope: { structured_output?: unknown; result?: string; is_error?: boolean };
  try {
    envelope = JSON.parse(result.stdout);
  } catch (err) {
    throw new ExtractionParseError(
      `claude CLI output not JSON: ${(err as Error).message}`,
      result.stdout,
      err,
    );
  }

  if (envelope.is_error) {
    throw new ExtractionParseError(
      `claude CLI reported error: ${envelope.result ?? '(no detail)'}`,
      result.stdout,
    );
  }

  if (!envelope.structured_output) {
    throw new ExtractionParseError(
      'claude CLI returned no structured_output (was --json-schema accepted?)',
      result.stdout,
    );
  }

  try {
    return validateExtraction(envelope.structured_output);
  } catch (err) {
    throw new ExtractionParseError(
      `Schema validation failed: ${(err as Error).message}`,
      JSON.stringify(envelope.structured_output),
      err,
    );
  }
}

export interface ExtractCodexCliOptions {
  transcript: string;
  model?: string;
  /** Test seam: replace the real `spawnSync` invocation. */
  spawnFn?: SpawnFn;
}

/**
 * Extract via the `codex` CLI in headless mode. Codex takes the JSON Schema
 * as a FILE PATH (not inline string) via `--output-schema`, and writes its
 * final assistant message to a file via `-o` / `--output-last-message`.
 *
 * Synchronous because `spawnSync` is sync — the dispatcher in
 * `extractWithProvider` wraps the result in a Promise.
 *
 * Auth: Codex auto-uses OPENAI_API_KEY if set, ChatGPT account otherwise.
 * We scrub OPENAI_API_KEY so users with both auth modes don't get surprise
 * API charges. They can still force API auth by setting the env var
 * themselves and bypassing this scrubbing if needed.
 */
export function extractCodexCli(opts: ExtractCodexCliOptions): Extraction {
  const tmpDir = mkdtempSync(join(tmpdir(), 'engram-codex-'));
  const schemaFile = join(tmpDir, 'schema.json');
  const outputFile = join(tmpDir, 'output.txt');
  writeFileSync(schemaFile, JSON.stringify(EXTRACTION_JSON_SCHEMA));

  // Codex has no separate --system-prompt; we inline everything in the
  // single positional prompt arg. Transcript is appended after the
  // extraction instructions.
  const prompt = `${EXTRACTION_PROMPT}\n\nTranscript:\n${opts.transcript}`;
  const args = [
    'exec', prompt,
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--output-schema', schemaFile,
    '-o', outputFile,
    ...(opts.model !== undefined ? ['--model', opts.model] : []),
  ];

  const fn: SpawnFn = opts.spawnFn ?? ((cmd, a, input) => {
    // Scrub OPENAI_API_KEY so codex uses ChatGPT account auth, not metered
    // API auth — same rationale as the claude-cli ANTHROPIC_API_KEY scrub.
    const childEnv = { ...process.env };
    delete childEnv['OPENAI_API_KEY'];
    const r = spawnSync(cmd, a, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv,
      ...(input !== undefined ? { input } : {}),
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status,
    };
  });

  const result = fn('codex', args);

  if (result.status !== 0) {
    throw new ExtractionParseError(
      `codex CLI exited ${result.status}: ${result.stderr.slice(0, 500)}`,
      result.stdout,
    );
  }

  let modelOutput: string;
  try {
    modelOutput = readFileSync(outputFile, 'utf8');
  } catch (err) {
    throw new ExtractionParseError(
      `codex CLI did not produce output file: ${(err as Error).message}`,
      result.stdout,
      err,
    );
  }

  // Codex may wrap the response in ```json fences even when given a schema.
  const cleaned = modelOutput
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ExtractionParseError(
      `codex CLI output not JSON: ${(err as Error).message}`,
      modelOutput,
      err,
    );
  }

  try {
    return validateExtraction(parsed);
  } catch (err) {
    throw new ExtractionParseError(
      `Schema validation failed: ${(err as Error).message}`,
      modelOutput,
      err,
    );
  }
}

export interface ExtractGeminiCliOptions {
  transcript: string;
  model?: string;
  /** Test seam: replace the real `spawnSync` invocation. */
  spawnFn?: SpawnFn;
}

/**
 * Extract via the `gemini` CLI in headless mode. Gemini has no native
 * `--system-prompt` or `--json-schema` flags, so we inline the extraction
 * instructions, the JSON Schema, and the transcript into a single `-p`
 * argument. The CLI returns a `{ session_id, response, stats }` envelope
 * via `-o json`; we parse `response` (the model's text) and then JSON.parse
 * that to get the extraction.
 *
 * Auth: Gemini uses GEMINI_API_KEY if set, Google account otherwise. Scrub
 * GEMINI_API_KEY for the same reason as the other providers.
 */
export function extractGeminiCli(opts: ExtractGeminiCliOptions): Extraction {
  const inlinedSchema = JSON.stringify(EXTRACTION_JSON_SCHEMA);
  const prompt = `${EXTRACTION_PROMPT}

Your response MUST be valid JSON matching this JSON Schema (no markdown fences, no commentary, just the JSON):
${inlinedSchema}

Transcript to analyze:
${opts.transcript}`;

  const args = [
    '-p', prompt,
    '-o', 'json',
    ...(opts.model !== undefined ? ['--model', opts.model] : []),
  ];

  const fn: SpawnFn = opts.spawnFn ?? ((cmd, a, input) => {
    const childEnv = { ...process.env };
    delete childEnv['GEMINI_API_KEY'];
    const r = spawnSync(cmd, a, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv,
      ...(input !== undefined ? { input } : {}),
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status,
    };
  });

  const result = fn('gemini', args);

  if (result.status !== 0) {
    throw new ExtractionParseError(
      `gemini CLI exited ${result.status}: ${result.stderr.slice(0, 500)}`,
      result.stdout,
    );
  }

  let envelope: { response?: string };
  try {
    envelope = JSON.parse(result.stdout);
  } catch (err) {
    throw new ExtractionParseError(
      `gemini CLI output not JSON: ${(err as Error).message}`,
      result.stdout,
      err,
    );
  }

  if (!envelope.response) {
    throw new ExtractionParseError(
      'gemini CLI returned no response field',
      result.stdout,
    );
  }

  // Strip optional markdown fences — even though we instructed Gemini not
  // to wrap, models occasionally do.
  const cleaned = envelope.response
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ExtractionParseError(
      `gemini model response not JSON: ${(err as Error).message}`,
      envelope.response,
      err,
    );
  }

  try {
    return validateExtraction(parsed);
  } catch (err) {
    throw new ExtractionParseError(
      `Schema validation failed: ${(err as Error).message}`,
      envelope.response,
      err,
    );
  }
}
