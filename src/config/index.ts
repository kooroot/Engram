import path from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export type { Config };

/**
 * Precedence (highest → lowest): explicit overrides > env vars > defaults.
 * Programmatic overrides must win so request-scoped settings (e.g., namespace
 * per REST request) aren't clobbered by ambient env.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const raw = {
    dataDir: overrides.dataDir ?? env['ENGRAM_DATA_DIR'],
    dbFilename: overrides.dbFilename ?? env['ENGRAM_DB_FILENAME'],
    vecDbFilename: overrides.vecDbFilename ?? env['ENGRAM_VEC_DB_FILENAME'],
    namespace: overrides.namespace ?? env['ENGRAM_NAMESPACE'],
    cache: overrides.cache,
    embedding: {
      provider: overrides.embedding?.provider ?? env['ENGRAM_EMBEDDING_PROVIDER'],
      dimension: overrides.embedding?.dimension,
      model: overrides.embedding?.model,
      apiKey: overrides.embedding?.apiKey ?? env['OPENAI_API_KEY'],
      baseUrl: overrides.embedding?.baseUrl ?? env['OPENAI_BASE_URL'],
    },
    maintenance: overrides.maintenance,
  };

  const parsed = ConfigSchema.parse(raw);

  return {
    ...parsed,
    dataDir: path.isAbsolute(parsed.dataDir)
      ? parsed.dataDir
      : path.resolve(process.cwd(), parsed.dataDir),
  };
}
