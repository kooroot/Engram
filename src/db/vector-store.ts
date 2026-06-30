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
  private namespace: string;

  private insertEmbeddingStmt: Stmt;
  private insertVecStmt: Stmt | null = null;
  private deleteEmbeddingStmt: Stmt;
  private deleteVecStmt: Stmt | null = null;
  private getBySourceStmt: Stmt;
  private getMetaByIdStmt: Stmt;

  private searchAllStmt: Stmt | null = null;
  private searchByTypeStmt: Stmt | null = null;
  private hasVecStmt: Stmt | null = null;

  constructor(
    private db: Database.Database,
    dimension: number = 1536,
    namespace: string = 'default',
  ) {
    this.dimension = dimension;
    this.namespace = namespace;

    this.insertEmbeddingStmt = db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, source_type, source_id, text, created_at, namespace)
      VALUES (@id, @source_type, @source_id, @text, strftime('%Y-%m-%dT%H:%M:%f','now'), @namespace)
    `);
    this.deleteEmbeddingStmt = db.prepare('DELETE FROM embeddings WHERE id = ? AND namespace = ?');
    this.getBySourceStmt = db.prepare(
      'SELECT * FROM embeddings WHERE source_type = ? AND source_id = ? AND namespace = ?'
    );
    this.getMetaByIdStmt = db.prepare('SELECT * FROM embeddings WHERE id = ? AND namespace = ?');
  }

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
      this.hasVecStmt = this.db.prepare(
        'SELECT 1 FROM vec_embeddings WHERE id = ? LIMIT 1'
      );
      // Namespace filter joins via embeddings metadata
      this.searchAllStmt = this.db.prepare(`
        SELECT v.id, v.distance
        FROM vec_embeddings v
        INNER JOIN embeddings e ON e.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
          AND e.namespace = ?
        ORDER BY v.distance ASC
      `);
      this.searchByTypeStmt = this.db.prepare(`
        SELECT v.id, v.distance
        FROM vec_embeddings v
        INNER JOIN embeddings e ON e.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
          AND e.source_type = ?
          AND e.namespace = ?
        ORDER BY v.distance ASC
      `);
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

  get ns(): string {
    return this.namespace;
  }

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
      namespace: this.namespace,
    });

    if (this.vecEnabled && this.insertVecStmt) {
      const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      this.insertVecStmt.run(id, buffer);
    }

    return id;
  }

  /**
   * The embed-input text currently stored for a source — but ONLY when it is
   * backed by a live vector row. Lets the auto-embed hook skip re-embedding when
   * the text is unchanged, without the risk of leaving a node permanently
   * without a vector. Returns null when there is no row, more than one row
   * (ambiguous — re-embed to self-heal), or the metadata row exists but its
   * vector is missing (self-heal). Namespace-scoped via getBySourceStmt.
   */
  getStoredEmbedText(sourceType: string, sourceId: string): string | null {
    const rows = this.getBySourceStmt.all(
      sourceType, sourceId, this.namespace
    ) as Array<{ id: string; text: string }>;
    if (rows.length !== 1) return null;
    const { id, text } = rows[0];
    if (this.vecEnabled && (!this.hasVecStmt || !this.hasVecStmt.get(id))) return null;
    return text;
  }

  /**
   * Source IDs in this namespace that have a LIVE vector (a metadata row whose
   * `id` also exists in vec_embeddings). The set the reembed backfill subtracts
   * from "all nodes" to find what still needs embedding — a metadata row without
   * a vec row counts as missing, so it gets re-embedded. Empty when vec is off.
   */
  liveSourceIds(sourceType: string): Set<string> {
    if (!this.vecEnabled) return new Set();
    const rows = this.db.prepare(`
      SELECT e.source_id AS sid
      FROM embeddings e
      INNER JOIN vec_embeddings v ON v.id = e.id
      WHERE e.source_type = ? AND e.namespace = ?
    `).all(sourceType, this.namespace) as Array<{ sid: string }>;
    return new Set(rows.map(r => r.sid));
  }

  /**
   * The dimension baked into the existing vec_embeddings table (`float[N]`),
   * parsed from its CREATE statement — or null when vec is off / the table is
   * absent. The reembed guard compares this against the provider's dimension:
   * vec0 columns are fixed-width, so a model swap to a different dimension can't
   * INSERT and must rebuild the (namespace-shared) table rather than backfill.
   */
  tableDimension(): number | null {
    if (!this.vecEnabled) return null;
    const row = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'"
    ).get() as { sql: string | null } | undefined;
    const match = row?.sql?.match(/float\[(\d+)\]/i);
    return match ? Number(match[1]) : null;
  }

  removeBySource(sourceType: string, sourceId: string): number {
    const existing = this.getBySourceStmt.all(
      sourceType, sourceId, this.namespace
    ) as Array<{ id: string }>;

    for (const row of existing) {
      this.deleteEmbeddingStmt.run(row.id, this.namespace);
      if (this.vecEnabled && this.deleteVecStmt) {
        this.deleteVecStmt.run(row.id);
      }
    }

    return existing.length;
  }

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

    if (params.sourceType && params.sourceType !== 'all' && this.searchByTypeStmt) {
      results = this.searchByTypeStmt.all(buffer, limit, params.sourceType, this.namespace) as unknown as Array<{ id: string; distance: number }>;
    } else if (this.searchAllStmt) {
      results = this.searchAllStmt.all(buffer, limit, this.namespace) as unknown as Array<{ id: string; distance: number }>;
    } else {
      return [];
    }

    const output: VectorSearchResult[] = [];

    for (const row of results) {
      const meta = this.getMetaByIdStmt.get(row.id, this.namespace) as {
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
