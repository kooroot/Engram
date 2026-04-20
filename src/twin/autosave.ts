import { readFileSync, statSync } from 'node:fs';
import type { EngramCore } from '../service.js';
import type { CreateLinkOp } from '../types/operations.js';
import { extractWithProvider, type ProviderName } from './providers.js';
import type { Extraction, ExtractionItemT } from './schema.js';

export interface AutosaveReport {
  created: number;
  updated: number;
  skipped: number;
  linksCreated: number;
  errors: string[];
}

export interface RunAutosaveOpts {
  core: EngramCore;
  transcriptPath: string;
  provider: ProviderName;
  apiKey?: string;
  model?: string;
  /** Inject a custom extraction fn (for tests). */
  extractFn?: (transcript: string) => Promise<Extraction>;
  /** Skip if transcript file is smaller than this (default 200 bytes). */
  minTranscriptBytes?: number;
}

const KIND_TO_NODE_TYPE: Record<ExtractionItemT['kind'], string> = {
  decision: 'decision',
  preference: 'preference',
  fact: 'fact',
  insight: 'insight',
  person: 'person',
  project_update: 'project',
};

export async function runAutosave(opts: RunAutosaveOpts): Promise<AutosaveReport> {
  const report: AutosaveReport = {
    created: 0, updated: 0, skipped: 0, linksCreated: 0, errors: [],
  };

  const stat = statSync(opts.transcriptPath);
  const minBytes = opts.minTranscriptBytes ?? 200;
  if (stat.size < minBytes) {
    report.skipped = 1;
    return report;
  }

  const transcript = readFileSync(opts.transcriptPath, 'utf8');
  const extraction = opts.extractFn
    ? await opts.extractFn(transcript)
    : await extractWithProvider({
        provider: opts.provider,
        transcript,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });

  if (extraction.items.length === 0) return report;

  for (const item of extraction.items) {
    try {
      const nodeType = KIND_TO_NODE_TYPE[item.kind];
      const existing = opts.core.stateTree.getNodeByName(item.name);

      let nodeId: string;
      if (existing) {
        opts.core.stateTree.mutate([{
          op: 'update',
          node_id: existing.id,
          set: item.properties ?? {},
          summary: item.summary,
          confidence: item.confidence,
        }]);
        nodeId = existing.id;
        report.updated += 1;
      } else {
        const { results } = opts.core.stateTree.mutate([{
          op: 'create',
          type: nodeType,
          name: item.name,
          summary: item.summary,
          properties: item.properties ?? {},
          confidence: item.confidence,
        }]);
        nodeId = results[0]!.node_id;
        report.created += 1;
      }

      // Resolve link targets by name; silently skip missing (autosave runs after
      // session, target may legitimately not exist yet)
      const linkOps: CreateLinkOp[] = [];
      for (const link of item.links) {
        const target = opts.core.stateTree.getNodeByName(link.target_name);
        if (!target) continue;
        linkOps.push({
          op: 'create',
          source_id: nodeId,
          predicate: link.predicate,
          target_id: target.id,
          confidence: item.confidence,
        });
      }
      if (linkOps.length > 0) {
        opts.core.stateTree.link(linkOps);
        report.linksCreated += linkOps.length;
      }
    } catch (err) {
      report.errors.push(`${item.name}: ${(err as Error).message}`);
    }
  }

  return report;
}
