import { spawn } from 'node:child_process';
import type { EmbeddingProvider } from './index.js';

/**
 * Generic shell-based embedding provider. Spawns a user-configured command,
 * writes text on stdin, expects a JSON embedding on stdout.
 *
 * Supported stdout shapes:
 *   - Raw array:              [0.1, 0.2, ...]
 *   - OpenAI compat:          {"data": [{"embedding": [...]}]}
 *   - Simple object:          {"embedding": [...]}
 *
 * Typical use cases:
 *   ENGRAM_EMBEDDING_CMD="codex embed --stdin --json"
 *   ENGRAM_EMBEDDING_CMD="ollama run nomic-embed-text"
 *   ENGRAM_EMBEDDING_CMD="curl -sS http://localhost:8080/embed -d @-"
 */
export class ShellEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private readonly cmd: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: {
    command: string;
    dimension?: number;
    timeoutMs?: number;
  }) {
    if (!options.command || options.command.trim().length === 0) {
      throw new Error('ShellEmbeddingProvider requires ENGRAM_EMBEDDING_CMD to be set');
    }
    const parts = splitCommand(options.command);
    this.cmd = parts[0];
    this.args = parts.slice(1);
    this.dimension = options.dimension ?? 1536;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<number[]> {
    const raw = await this.runCommand(text);
    const vec = extractEmbedding(raw);
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(`ShellEmbeddingProvider: no embedding in stdout (got: ${raw.slice(0, 120)})`);
    }
    if (vec.length !== this.dimension) {
      throw new Error(
        `ShellEmbeddingProvider: dimension mismatch (expected ${this.dimension}, got ${vec.length}). ` +
        `Set ENGRAM_EMBEDDING_DIMENSION to match your model.`,
      );
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) results.push(await this.embed(t));
    return results;
  }

  private runCommand(stdinText: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ShellEmbeddingProvider: command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', err => {
        clearTimeout(timer);
        reject(new Error(`ShellEmbeddingProvider: spawn failed — ${err.message}`));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`ShellEmbeddingProvider: exit ${code}, stderr: ${stderr.slice(0, 240)}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.end(stdinText);
    });
  }
}

function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function extractEmbedding(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'number')) return parsed;
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.embedding)) return parsed.embedding;
      if (Array.isArray(parsed.data) && parsed.data[0]?.embedding) return parsed.data[0].embedding;
    }
    return null;
  } catch {
    return null;
  }
}
