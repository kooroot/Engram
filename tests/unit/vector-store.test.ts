import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { VectorStore } from '../../src/db/vector-store.js';
import { LocalEmbeddingProvider } from '../../src/embeddings/local.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-vec.db');
const DIM = 64;

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of ['004_init_vectors.sql', '006_add_vector_namespaces.sql']) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

function checkVecAvailable(): boolean {
  const db = setupDb();
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    db.close();
    return true;
  } catch {
    db.close();
    return false;
  }
}

const VEC_AVAILABLE = checkVecAvailable();

function hashVector(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  let seed = text.toLowerCase().trim();
  let idx = 0;
  while (idx < dim) {
    const hash = createHash('sha256').update(seed).digest();
    for (let i = 0; i < hash.length && idx < dim; i += 4) {
      vec[idx++] = (hash.readUInt32LE(i) / 0xFFFFFFFF) * 2 - 1;
    }
    seed = hash.toString('hex');
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) for (let i = 0; i < dim; i++) vec[i] /= mag;
  return vec;
}

function randomVec(dim: number): Float32Array {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = Math.random() * 2 - 1;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < dim; i++) vec[i] /= mag;
  return vec;
}

describe('VectorStore - Metadata Only', () => {
  let db: Database.Database;
  let store: VectorStore;

  beforeEach(() => {
    db = setupDb();
    store = new VectorStore(db, DIM);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should store embedding metadata', () => {
    const id = store.store({
      source_type: 'node',
      source_id: 'node-123',
      text: 'Alice is an engineer',
      embedding: new Float32Array(DIM),
    });
    expect(id).toBeTruthy();
    const rows = db.prepare('SELECT * FROM embeddings WHERE id = ?').all(id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe('node-123');
  });

  it('should return empty results for search without vec', () => {
    const results = store.search({ embedding: new Float32Array(DIM) });
    expect(results).toEqual([]);
    expect(store.isVecEnabled).toBe(false);
  });

  it('should remove embeddings by source', () => {
    store.store({ source_type: 'node', source_id: 'n1', text: 'a', embedding: new Float32Array(DIM) });
    store.store({ source_type: 'node', source_id: 'n1', text: 'b', embedding: new Float32Array(DIM) });
    store.store({ source_type: 'node', source_id: 'n2', text: 'c', embedding: new Float32Array(DIM) });
    const removed = store.removeBySource('node', 'n1');
    expect(removed).toBe(2);
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('should reject dimension mismatch', () => {
    expect(() => {
      store.store({
        source_type: 'node',
        source_id: 'n1',
        text: 'test',
        embedding: new Float32Array(DIM + 10),
      });
    }).toThrow(/dimension mismatch/i);
  });
});

describe('VectorStore - With sqlite-vec', () => {
  let db: Database.Database;
  let store: VectorStore;

  beforeEach(() => {
    db = setupDb();
    store = new VectorStore(db, DIM);
    if (VEC_AVAILABLE) {
      const sqliteVec = require('sqlite-vec');
      store.enableVec(sqliteVec.load);
    }
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it.skipIf(!VEC_AVAILABLE)('should store and search vectors', () => {
    const texts = ['Alice is a software engineer', 'Bob is a designer', 'The project uses TypeScript'];
    for (let i = 0; i < texts.length; i++) {
      store.store({
        source_type: 'node',
        source_id: `node-${i}`,
        text: texts[i],
        embedding: hashVector(texts[i], DIM),
      });
    }

    const queryVec = hashVector('Alice is a software engineer', DIM);
    const results = store.search({ embedding: queryVec, limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe('Alice is a software engineer');
    expect(results[0].distance).toBe(0);
  });

  it.skipIf(!VEC_AVAILABLE)('should filter by source_type', () => {
    store.store({ source_type: 'node', source_id: 'n1', text: 'node text', embedding: randomVec(DIM) });
    store.store({ source_type: 'event', source_id: 'e1', text: 'event text', embedding: randomVec(DIM) });

    const nodeResults = store.search({ embedding: randomVec(DIM), sourceType: 'node', limit: 10 });
    for (const r of nodeResults) expect(r.source_type).toBe('node');
  });
});

describe('LocalEmbeddingProvider', () => {
  it('should generate deterministic embeddings', async () => {
    const provider = new LocalEmbeddingProvider(DIM);
    const vec1 = await provider.embed('hello world');
    const vec2 = await provider.embed('hello world');
    expect(vec1).toEqual(vec2);
    expect(vec1.length).toBe(DIM);
  });

  it('should generate unit vectors', async () => {
    const provider = new LocalEmbeddingProvider(DIM);
    const vec = await provider.embed('test text');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('should generate different vectors for different text', async () => {
    const provider = new LocalEmbeddingProvider(DIM);
    const vec1 = await provider.embed('hello');
    const vec2 = await provider.embed('world');
    expect(vec1).not.toEqual(vec2);
  });

  it('should embed batch', async () => {
    const provider = new LocalEmbeddingProvider(DIM);
    const results = await provider.embedBatch(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    for (const vec of results) expect(vec.length).toBe(DIM);
  });
});
