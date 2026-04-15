import { z } from 'zod';

export const ConfigSchema = z.object({
  dataDir: z.string().default('./data'),
  dbFilename: z.string().default('engram.db'),
  vecDbFilename: z.string().default('engram-vec.db'),

  /** Namespace for memory isolation (multi-tenant/multi-project). Default 'default'. */
  namespace: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_\-.]+$/,
    'Namespace must be alphanumeric with dashes/dots/underscores').default('default'),

  cache: z.object({
    maxNodes: z.number().int().positive().default(10_000),
    nodeTTLMs: z.number().int().positive().default(300_000),
    contextCacheSize: z.number().int().positive().default(100),
    contextTTLMs: z.number().int().positive().default(60_000),
  }).default({}),

  embedding: z.object({
    provider: z.enum(['openai', 'local', 'shell', 'ollama', 'none']).default('none'),
    dimension: z.number().int().positive().default(1536),
    model: z.string().default('text-embedding-3-small'),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    shellCmd: z.string().optional(),
    shellTimeoutMs: z.number().int().positive().default(30_000),
    ollamaUrl: z.string().optional(),
    ollamaModel: z.string().optional(),
  }).default({}),

  maintenance: z.object({
    confidenceDecayFactor: z.number().min(0).max(1).default(0.95),
    archiveConfidenceThreshold: z.number().min(0).max(1).default(0.3),
    archiveInactiveDays: z.number().int().positive().default(90),
    orphanGraceDays: z.number().int().positive().default(30),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
