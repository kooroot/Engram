import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExtractionSchema, validateExtraction } from '../../src/twin/schema.js';
import { extractWithProvider, ExtractionParseError } from '../../src/twin/providers.js';
import { runAutosave } from '../../src/twin/autosave.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngramServer, type EngramServer } from '../../src/server.js';
import path from 'node:path';
import fs from 'node:fs';

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

  it('rejects unknown top-level keys (strict mode)', () => {
    expect(() => validateExtraction({ items: [], extra: 'nope' })).toThrow();
  });

  it('rejects unknown per-item keys (strict mode)', () => {
    expect(() => validateExtraction({
      items: [{
        kind: 'fact', name: 'x', summary: 'y', confidence: 0.5, links: [],
        bogus: true,
      }],
    })).toThrow();
  });

  it('defaults missing properties to empty object', () => {
    const parsed = validateExtraction({
      items: [{
        kind: 'fact', name: 'x', summary: 'y', confidence: 0.5, links: [],
      }],
    });
    expect(parsed.items[0]?.properties).toEqual({});
  });

  it('trims whitespace in name and summary', () => {
    const parsed = validateExtraction({
      items: [{
        kind: 'fact', name: '  spaced  ', summary: '  summary  ',
        confidence: 0.5, links: [],
      }],
    });
    expect(parsed.items[0]?.name).toBe('spaced');
    expect(parsed.items[0]?.summary).toBe('summary');
  });

  it('caps links at 20 per item', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      predicate: 'p', target_name: `t${i}`,
    }));
    expect(() => validateExtraction({
      items: [{
        kind: 'fact', name: 'x', summary: 'y', confidence: 0.5, links: tooMany,
      }],
    })).toThrow();
  });
});

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
    expect(result.items[0]?.name).toBe('Test fact');
  });

  it('strips ```json fences before parsing', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{
            type: 'text',
            text: '```json\n{"items":[]}\n```',
          }],
        }),
      },
    };
    const result = await extractWithProvider({
      provider: 'anthropic',
      transcript: 'x',
      client: fakeClient as any,
    });
    expect(result.items).toEqual([]);
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

  it('throws when provider returns no text content', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({ content: [{ type: 'tool_use' }] }),
      },
    };
    await expect(extractWithProvider({
      provider: 'anthropic',
      transcript: 'x',
      client: fakeClient as any,
    })).rejects.toThrow(/no text content/);
  });

  it('strips bare ``` fences (no language tag)', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '```\n{"items":[]}\n```' }],
        }),
      },
    };
    const result = await extractWithProvider({
      provider: 'anthropic', transcript: 'x', client: fakeClient as any,
    });
    expect(result.items).toEqual([]);
  });

  it('strips ```javascript and other tag variants', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '```javascript\n{"items":[]}\n```' }],
        }),
      },
    };
    const result = await extractWithProvider({
      provider: 'anthropic', transcript: 'x', client: fakeClient as any,
    });
    expect(result.items).toEqual([]);
  });

  it('wraps JSON.parse failure in ExtractionParseError with raw text', async () => {
    const garbage = '{ "items": [ { not valid json';
    const fakeClient = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: garbage }] }),
      },
    };
    try {
      await extractWithProvider({
        provider: 'anthropic', transcript: 'x', client: fakeClient as any,
      });
      throw new Error('expected ExtractionParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionParseError);
      expect((err as ExtractionParseError).rawText).toBe(garbage);
      expect((err as Error).message).toMatch(/JSON.parse failed/);
    }
  });

  it('wraps schema-violation in ExtractionParseError with raw text', async () => {
    const text = JSON.stringify({ items: [{ kind: 'banana' }] });
    const fakeClient = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text }] }),
      },
    };
    try {
      await extractWithProvider({
        provider: 'anthropic', transcript: 'x', client: fakeClient as any,
      });
      throw new Error('expected ExtractionParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionParseError);
      expect((err as ExtractionParseError).rawText).toBe(text);
      expect((err as Error).message).toMatch(/Schema validation failed/);
    }
  });

  it('passes temperature: 0 and max_tokens: 4000 to the SDK', async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const fakeClient = {
      messages: {
        create: async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return { content: [{ type: 'text', text: '{"items":[]}' }] };
        },
      },
    };
    await extractWithProvider({
      provider: 'anthropic', transcript: 'x', client: fakeClient as any,
    });
    expect(capturedArgs!['temperature']).toBe(0);
    expect(capturedArgs!['max_tokens']).toBe(4000);
  });
});

const TEST_DATA_DIR = path.join(import.meta.dirname, '..', '.test-data', 'twin-autosave');

describe('runAutosave', () => {
  let engram: EngramServer;
  let transcriptPath: string;

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const config = loadConfig({ dataDir: TEST_DATA_DIR });
    engram = createEngramServer(config);
    transcriptPath = path.join(TEST_DATA_DIR, 'transcript.txt');
  });

  afterEach(() => {
    engram.close();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('creates new nodes from extraction', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500)); // big enough to pass min-bytes
    const report = await runAutosave({
      core: engram,
      transcriptPath,
      provider: 'anthropic',
      extractFn: async () => ({
        items: [{
          kind: 'preference', name: 'Tabs over spaces',
          summary: 'User prefers tabs', properties: {}, confidence: 0.95, links: [],
        }],
      }),
    });
    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    expect(engram.stateTree.getNodeByName('Tabs over spaces')).not.toBeNull();
  });

  it('updates existing node instead of duplicating', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    const item = {
      kind: 'preference' as const, name: 'Use bun',
      summary: 'first save', properties: {}, confidence: 0.8, links: [],
    };
    await runAutosave({ core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({ items: [item] }) });
    const report = await runAutosave({ core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({ items: [{ ...item, summary: 'updated save' }] }) });
    expect(report.created).toBe(0);
    expect(report.updated).toBe(1);
    const node = engram.stateTree.getNodeByName('Use bun');
    expect(node?.summary).toBe('updated save');
  });

  it('skips when transcript is too small', async () => {
    fs.writeFileSync(transcriptPath, 'tiny');
    const report = await runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => { throw new Error('should not be called'); },
      minTranscriptBytes: 100,
    });
    expect(report.skipped).toBe(1);
    expect(report.created).toBe(0);
  });

  it('returns zero counts when extraction is empty', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    const report = await runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({ items: [] }),
    });
    expect(report.created).toBe(0);
    expect(report.updated).toBe(0);
  });

  it('creates links between extracted items when targets exist', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    // Pre-create the target node so the link target_name resolves
    engram.stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram', summary: 'memory system' },
    ]);
    const report = await runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({
        items: [{
          kind: 'decision', name: 'Use SQLite',
          summary: 'chose SQLite', properties: {}, confidence: 0.9,
          links: [{ predicate: 'decided_in', target_name: 'Engram' }],
        }],
      }),
    });
    expect(report.created).toBe(1);
    expect(report.linksCreated).toBe(1);
  });

  it('records error but continues when one item fails', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    const report = await runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({
        items: [
          { kind: 'fact', name: 'good item',
            summary: 'ok', properties: {}, confidence: 0.5, links: [] },
          { kind: 'fact', name: 'item with bad link',
            summary: 'has missing target', properties: {}, confidence: 0.5,
            links: [{ predicate: 'rel', target_name: 'definitely-not-in-db' }] },
        ],
      }),
    });
    expect(report.created).toBe(2);
    // Bad link silently skipped (target missing) — not an error
    expect(report.linksCreated).toBe(0);
  });

  it('logs raw text when provider throws ExtractionParseError', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    const { ExtractionParseError } = await import('../../src/twin/providers.js');
    await expect(runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => {
        throw new ExtractionParseError('bad json', '{ broken');
      },
    })).rejects.toThrow(/bad json/);
  });

  it('dedups same-name items within one batch, keeping highest confidence', async () => {
    fs.writeFileSync(transcriptPath, 'A'.repeat(500));
    const report = await runAutosave({
      core: engram, transcriptPath, provider: 'anthropic',
      extractFn: async () => ({
        items: [
          { kind: 'preference', name: 'Use bun',
            summary: 'lower conf', properties: {}, confidence: 0.5, links: [] },
          { kind: 'decision', name: 'Use bun',
            summary: 'higher conf', properties: {}, confidence: 0.95, links: [] },
        ],
      }),
    });
    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.duplicatesInBatch).toBe(1);
    const node = engram.stateTree.getNodeByName('Use bun');
    expect(node?.summary).toBe('higher conf');
  });
});
