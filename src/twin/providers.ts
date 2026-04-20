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
