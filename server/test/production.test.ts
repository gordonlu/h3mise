import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { createBeat, updateStory } from '../src/modules/story.js';
import { createShot } from '../src/modules/shots.js';
import { productionOverview } from '../src/modules/production.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

async function fixture(tag: string) {
  const { root, store } = await makeStore(tag);
  roots.push(root);
  const project = await makeProject(store, tag);
  project.config.default_provider = 'mock';
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  return { project, registry };
}

test('production overview reports an empty story and missing shots as next actions', async () => {
  const { project, registry } = await fixture('production-empty');
  const overview = await productionOverview(project, registry);
  assert.equal(overview.summary.shotCount, 0);
  assert.equal(overview.nextActions[0]?.id, 'shots-empty');
  assert.ok(overview.issues.some((item) => item.id === 'story-empty'));
});

test('production overview detects duration drift and uncovered story beats', async () => {
  const { project, registry } = await fixture('production-story');
  updateStory(project, { body: 'A complete short story.', plannedDurationSeconds: 30 });
  createBeat(project, { title: 'Opening', durationSeconds: 10 });
  createShot(project, { title: 'Shot A', durationSeconds: 8, h3Mode: 't2va', renderDependencyMode: 'independent' });
  createShot(project, { title: 'Shot B', durationSeconds: 8, h3Mode: 't2va', renderDependencyMode: 'independent' });

  const overview = await productionOverview(project, registry);
  assert.equal(overview.summary.shotDurationSeconds, 16);
  assert.equal(overview.summary.remainingShotCount, 2);
  assert.ok(overview.issues.some((item) => item.id === 'duration-mismatch'));
  assert.ok(overview.issues.some((item) => item.id === 'beats-uncovered'));
  assert.equal(overview.shots.length, 2);
});
