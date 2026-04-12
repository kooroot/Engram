import type { StateTree } from '../../src/db/state-tree.js';

/**
 * Seeds a test graph:
 *
 *   Alice --works_on--> Engram
 *   Bob   --works_on--> Engram
 *   Alice --knows-----> Bob
 *   Bob   --knows-----> Charlie
 *   Alice --prefers---> TypeScript
 *   Engram --is_a-----> Project
 *   TypeScript --is_a--> Language
 */
export function seedTestGraph(stateTree: StateTree) {
  const { results: nodes } = stateTree.mutate([
    { op: 'create', type: 'person', name: 'Alice', properties: { role: 'engineer', level: 'senior' }, summary: 'Senior engineer, team lead' },
    { op: 'create', type: 'person', name: 'Bob', properties: { role: 'designer' } },
    { op: 'create', type: 'person', name: 'Charlie', properties: { role: 'pm' } },
    { op: 'create', type: 'project', name: 'Engram', properties: { status: 'active', domain: 'AI' }, summary: 'AI-native memory system' },
    { op: 'create', type: 'concept', name: 'TypeScript', properties: { category: 'language' } },
    { op: 'create', type: 'concept', name: 'Project', properties: { category: 'meta' } },
    { op: 'create', type: 'concept', name: 'Language', properties: { category: 'meta' } },
  ]);

  const [alice, bob, charlie, engram, typescript, project, language] = nodes;

  stateTree.link([
    { op: 'create', source_id: alice.node_id, predicate: 'works_on', target_id: engram.node_id },
    { op: 'create', source_id: bob.node_id, predicate: 'works_on', target_id: engram.node_id },
    { op: 'create', source_id: alice.node_id, predicate: 'knows', target_id: bob.node_id },
    { op: 'create', source_id: bob.node_id, predicate: 'knows', target_id: charlie.node_id },
    { op: 'create', source_id: alice.node_id, predicate: 'prefers', target_id: typescript.node_id },
    { op: 'create', source_id: engram.node_id, predicate: 'is_a', target_id: project.node_id },
    { op: 'create', source_id: typescript.node_id, predicate: 'is_a', target_id: language.node_id },
  ]);

  return { alice, bob, charlie, engram, typescript, project, language };
}
