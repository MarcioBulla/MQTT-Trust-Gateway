import test from 'node:test';
import assert from 'node:assert/strict';
import { helpTopics, helpTopicById } from '../frontend/help/help-topics.js';

test('initial Help registry provides the five requested unique topics', () => {
  const ids = helpTopics.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'register-device',
    'generate-complete-certificate',
    'sign-existing-csr',
    'generate-csr-external-signing',
    'import-certificate',
  ]) assert.ok(helpTopicById[id], `Missing help topic: ${id}`);
});

test('every article has a textual sequence and resolvable related links', () => {
  for (const topic of helpTopics) {
    assert.ok(topic.sequence.length, `${topic.id} has no readable sequence fallback`);
    assert.ok(topic.mermaid.includes('sequenceDiagram'), `${topic.id} has no Mermaid source`);
    for (const relatedId of topic.relatedTopicIds) assert.ok(helpTopicById[relatedId], `${topic.id} links to missing ${relatedId}`);
  }
});

test('certificate articles explain key ownership and preserve the trust and authorization distinction', () => {
  const generated = helpTopicById['generate-complete-certificate'];
  const csr = helpTopicById['sign-existing-csr'];
  const external = helpTopicById['generate-csr-external-signing'];
  const imported = helpTopicById['import-certificate'];
  assert.match(generated.artifacts.join(' '), /retains the public certificate and metadata, not device\.key/i);
  assert.match(csr.artifacts.join(' '), /stays on the device\/host/i);
  assert.match(external.artifacts.join(' '), /temporary memory-only state/i);
  assert.match(imported.overview, /discarded/i);
  assert.match(imported.overview, /not.*stored/i);
  assert.match(imported.steps.join(' '), /explicitly approve its CA/i);
  assert.match(imported.steps.join(' '), /authorize the identity/i);
});
