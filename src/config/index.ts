import path from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export type { Config };

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const embeddingProvider = process.env['ENGRAM_EMBEDDING_PROVIDER'];
  const raw = {
    dataDir: process.env['ENGRAM_DATA_DIR'] ?? overrides.dataDir,
    dbFilename: process.env['ENGRAM_DB_FILENAME'] ?? overrides.dbFilename,
    vecDbFilename: process.env['ENGRAM_VEC_DB_FILENAME'] ?? overrides.vecDbFilename,
    cache: overrides.cache,
    embedding: {
      provider: embeddingProvider ?? overrides.embedding?.provider,
      dimension: overrides.embedding?.dimension,
      model: overrides.embedding?.model,
      apiKey: process.env['OPENAI_API_KEY'] ?? overrides.embedding?.apiKey,
      baseUrl: process.env['OPENAI_BASE_URL'] ?? overrides.embedding?.baseUrl,
    },
    maintenance: overrides.maintenance,
  };

  const config = ConfigSchema.parse(raw);

  // Resolve dataDir to absolute path
  if (!path.isAbsolute(config.dataDir)) {
    config.dataDir = path.resolve(process.cwd(), config.dataDir);
  }

  return config;
}
