/* eslint-disable no-console */
/** Populate two namespaces for E2E verification */
import { createEngramCore } from '../src/service.js';

const which = process.argv[2];
const core = createEngramCore();
console.log(`populating namespace: ${core.config.namespace}`);

if (which === 'personal') {
  core.stateTree.mutate([
    { op: 'create', type: 'person', name: 'PersonalAlice', summary: 'My sister' },
    { op: 'create', type: 'note', name: 'favorite-food', summary: 'pizza' },
  ]);
} else if (which === 'work') {
  core.stateTree.mutate([
    { op: 'create', type: 'person', name: 'WorkAlice', summary: 'Lead engineer on platform team' },
    { op: 'create', type: 'project', name: 'Engram', summary: 'AI memory system' },
  ]);
} else {
  console.error('Usage: populate-ns.ts <personal|work>');
  process.exit(1);
}

await core.closeAsync();
console.log('done');
