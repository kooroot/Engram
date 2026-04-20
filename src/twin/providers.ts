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
    name: string,
    summary: string,
    properties?: Record<string, unknown>,
    confidence: number,
    links: Array<{ predicate: string, target_name: string }>
  }>
}

If nothing substantive was discussed, return { "items": [] }.`;

export interface ExtractOptions {
  provider: ProviderName;
  transcript: string;
  apiKey?: string;
  client?: Anthropic;
  model?: string;
}

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
  if (opts.provider !== 'anthropic') {
    throw new Error(`Provider not yet implemented: ${opts.provider}`);
  }
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
