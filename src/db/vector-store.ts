import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

type Stmt = Database.Statement;

export interface VectorSearchResult {
  id: string;
  source_type: string;
  source_id: string;
  text: string;
  distance: number;
}

export class VectorStore {
  private vecEnabled: boolean = false;
  private dimension: number;

  private insertEmbeddingStmt: Stmt;
  private insertVecStmt: Stmt | null = null;
  private deleteEmbeddingStmt: Stmt;
  private deleteVecStmt: Stmt | null = null;
  private getBySourceStmt: Stmt;

  constructor(
    private db: Database.Database,
    dimension: number = 1536,
  ) {
    this.dimension = dimension;

    // Metadata table (always available, created by migration)
    this.insertEmbeddingStmt = db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, source_type, source_id, text, created_at)
      VALUES (@id, @source_type, @source_id, @text, strftime('%Y-%m-%dT%H:%M:%f','now'))
    `);
    this.deleteEmbeddingStmt = db.prepare('DELETE FROM embeddings WHERE id = ?');
    this.getBySourceStmt = db.prepare(
      'SELECT * FROM embeddings WHERE source_type = ? AND source_id = ?'
    );
  }

  /**
   * Attempt to load the sqlite-vec extension. Call after construction.
   * Separated so callers can handle errors gracefully.
   */
  enableVec(loadFn: (db: Database.Database) => void): boolean {
    try {
      loadFn(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${this.dimension}]
        )
      `);
      this.insertVecStmt = this.db.prepare(
        'INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)'
      );
      this.deleteVecStmt = this.db.prepare(
        'DELETE FROM vec_embeddings WHERE id = ?'
      );
      this.vecEnabled = true;
      return true;
    } catch {
      this.vecEnabled = false;
      return false;
    }
  }

  get isVecEnabled(): boolean {
    return this.vecEnabled;
  }

  /**
   * Store a text and its embedding vector.
   */
  store(params: {
    source_type: 'node' | 'event' | 'edge_context';
    source_id: string;
    text: string;
    embedding: Float32Array | number[];
  }): string {
    const id = ulid();
    const vec = params.embedding instanceof Float32Array
      ? params.embedding
      : new Float32Array(params.embedding);

    if (vec.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimension}, got ${vec.length}`
      );
    }

    this.insertEmbeddingStmt.run({
      id,
      source_type: params.source_type,
      source_id: params.source_id,
      text: params.text,
    });

    if (this.vecEnabled && this.insertVecStmt) {
      const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      this.insertVecStmt.run(id, buffer);
    }

    return id;
  }

  /**
   * Remove embeddings for a given source entity.
   */
  removeBySource(sourceType: string, sourceId: string): number {
    const existing = this.getBySourceStmt.all(
      sourceType, sourceId
    ) as Array<{ id: string }>;

    for (const row of existing) {
      this.deleteEmbeddingStmt.run(row.id);
      if (this.vecEnabled && this.deleteVecStmt) {
        this.deleteVecStmt.run(row.id);
      }
    }

    return existing.length;
  }

  /**
   * KNN search against stored embeddings.
   * Returns results sorted by distance (ascending = most similar).
   */
  search(params: {
    embedding: Float32Array | number[];
    limit?: number;
    sourceType?: string;
  }): VectorSearchResult[] {
    if (!this.vecEnabled) {
      return [];
    }

    const vec = params.embedding instanceof Float32Array
      ? params.embedding
      : new Float32Array(params.embedding);
    const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

    const limit = params.limit ?? 5;

    let results: Array<{ id: string; distance: number }>;

    if (params.sourceType && params.sourceType !== 'all') {
      const stmt = this.db.prepare(`
        SELECT v.id, v.distance
        FROM vec_embeddings v
        INNER JOIN embeddings e ON e.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
          AND e.source_type = ?
        ORDER BY v.distance ASC
      `);
      results = stmt.all(buffer, limit, params.sourceType) as any[];
    } else {
      const stmt = this.db.prepare(`
        SELECT id, distance
        FROM vec_embeddings
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance ASC
      `);
      results = stmt.all(buffer, limit) as any[];
    }

    const getMetaStmt = this.db.prepare('SELECT * FROM embeddings WHERE id = ?');
    const output: VectorSearchResult[] = [];

    for (const row of results) {
      const meta = getMetaStmt.get(row.id) as {
        id: string;
        source_type: string;
        source_id: string;
        text: string;
      } | undefined;
      if (meta) {
        output.push({
          id: meta.id,
          source_type: meta.source_type,
          source_id: meta.source_id,
          text: meta.text,
          distance: row.distance,
        });
      }
    }

    return output;
  }
}
