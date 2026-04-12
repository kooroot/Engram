import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { createEngramServer, type EngramServer } from '../../src/server.js';
import { traverseGraph } from '../../src/engine/graph-traversal.js';
import { buildContext } from '../../src/engine/context-builder.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '..', '.test-data', 'integration');

function setup(): EngramServer {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true });
  }
  const config = loadConfig({ dataDir: TEST_DATA_DIR });
  return createEngramServer(config);
}

describe('Engram Integration - Full Lifecycle', () => {
  let engram: EngramServer;

  beforeEach(() => {
    engram = setup();
  });

  afterEach(() => {
    engram.close();
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('should create nodes, link them, query, and update', () => {
    // 1. Create nodes
    const { results: nodeResults } = engram.stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice', properties: { role: 'engineer' }, summary: 'Senior backend engineer' },
      { op: 'create', type: 'project', name: 'Engram', properties: { status: 'active' }, summary: 'AI memory system' },
      { op: 'create', type: 'concept', name: 'GraphDB', properties: { domain: 'databases' } },
    ]);

    expect(nodeResults).toHaveLength(3);
    const [alice, engramProject, graphdb] = nodeResults;

    // 2. Link entities
    const { results: linkResults } = engram.stateTree.link([
      { op: 'create', source_id: alice.node_id, predicate: 'works_on', target_id: engramProject.node_id },
      { op: 'create', source_id: engramProject.node_id, predicate: 'uses', target_id: graphdb.node_id },
    ]);
    expect(linkResults).toHaveLength(2);

    // 3. Query by name
    const aliceNode = engram.stateTree.getNodeByName('Alice');
    expect(aliceNode).not.toBeNull();
    expect(aliceNode!.properties).toEqual({ role: 'engineer' });

    // 4. Query edges
    const aliceEdges = engram.stateTree.getEdgesFrom(alice.node_id);
    expect(aliceEdges).toHaveLength(1);
    expect(aliceEdges[0].predicate).toBe('works_on');

    // 5. Log an event
    const event = engram.eventLog.append({
      type: 'observation',
      source: 'user',
      content: { note: 'Alice is the team lead' },
    });
    expect(event.id).toBeGreaterThan(0);

    // 6. Verify event log integrity
    expect(engram.eventLog.verifyIntegrity().valid).toBe(true);

    // 7. Update a node
    engram.stateTree.mutate([
      { op: 'update', node_id: alice.node_id, set: { role: 'lead engineer', team: 'platform' } },
    ]);

    const updatedAlice = engram.stateTree.getNode(alice.node_id);
    expect(updatedAlice!.properties).toEqual({ role: 'lead engineer', team: 'platform' });
    expect(updatedAlice!.version).toBe(2);
  });

  it('should handle graph traversal and context building', () => {
    const { results } = engram.stateTree.mutate([
      { op: 'create', type: 'person', name: 'Bob', summary: 'Frontend developer' },
      { op: 'create', type: 'concept', name: 'React', summary: 'UI library' },
      { op: 'create', type: 'concept', name: 'JavaScript', summary: 'Programming language' },
    ]);

    const [bob, react, javascript] = results;

    engram.stateTree.link([
      { op: 'create', source_id: bob.node_id, predicate: 'knows', target_id: react.node_id },
      { op: 'create', source_id: react.node_id, predicate: 'is_a', target_id: javascript.node_id },
    ]);

    // Traverse 2-hop from Bob
    const result = traverseGraph(engram.stateTree, {
      from: bob.node_id,
      direction: 'outgoing',
      depth: 2,
    });

    expect(result.nodes.map(n => n.name)).toContain('React');
    expect(result.nodes.map(n => n.name)).toContain('JavaScript');

    // Build context
    const context = buildContext(result.nodes, result.edges, { maxTokens: 500 });
    expect(context).toContain('Bob');
    expect(context).toContain('React');
    expect(context).toContain('knows');
  });

  it('should maintain event log integrity across operations', () => {
    engram.stateTree.mutate([{ op: 'create', type: 'person', name: 'Charlie' }]);
    engram.stateTree.mutate([{ op: 'create', type: 'project', name: 'Atlas' }]);
    engram.eventLog.append({ type: 'observation', source: 'agent', content: { note: 'test' } });

    const allMutations = engram.eventLog.queryByType('mutation');
    expect(allMutations.length).toBeGreaterThanOrEqual(2);

    const allObservations = engram.eventLog.queryByType('observation');
    expect(allObservations).toHaveLength(1);

    expect(engram.eventLog.verifyIntegrity().valid).toBe(true);
  });

  it('should cache and invalidate context results', () => {
    engram.stateTree.mutate([
      { op: 'create', type: 'person', name: 'Diana', summary: 'Data scientist' },
    ]);

    const node = engram.stateTree.getNodeByName('Diana')!;

    engram.cache.setContext('test-key', 'cached result', [node.id]);
    expect(engram.cache.getContext('test-key')).toBe('cached result');

    // Invalidate on node mutation
    engram.cache.invalidateNode(node.id);
    expect(engram.cache.getContext('test-key')).toBeNull();
  });
});
