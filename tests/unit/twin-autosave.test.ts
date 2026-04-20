import { describe, it, expect } from 'vitest';
import { ExtractionSchema, validateExtraction } from '../../src/twin/schema.js';
import { extractWithProvider } from '../../src/twin/providers.js';

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
});
