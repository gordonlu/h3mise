import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AIService, DirectorModel } from '../src/modules/ai.js';
import { applySkeleton, localRecommendations, recommendSkeletons } from '../src/modules/story-skeletons.js';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { listBeats, updateStory } from '../src/modules/story.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('local theme matching recommends delayed evidence for workplace credit theft', () => {
  const result = localRecommendations('职场新人被领导抢功，被冤枉后拿出录像证据打脸');
  assert.equal(result[0]?.skeleton.id, 'delayed-evidence');
  assert.match(result[0]?.reason ?? '', /职场|证据|打脸/);
});

test('AI recommendation can only select existing skeleton ids', async () => {
  const model = {
    structured: async () => ({ recommendations: [
      { skeletonId: 'power-misjudgment', score: 0.95, reason: '身份与权力误判' },
      { skeletonId: 'invented-by-model', score: 1, reason: 'invalid' },
    ] }),
  } as unknown as DirectorModel;
  const result = await recommendSkeletons({ model } as AIService, '被看不起后身份揭晓');
  assert.equal(result.mode, 'ai');
  assert.equal(result.recommendations[0]?.skeleton.id, 'power-misjudgment');
  assert.ok(result.recommendations.every((item) => item.skeleton.id !== 'invented-by-model'));
});

test('missing AI keeps the complete local skeleton workflow usable', async () => {
  const result = await recommendSkeletons({ model: null } as AIService, '倒计时救援');
  assert.equal(result.mode, 'local');
  assert.equal(result.recommendations[0]?.skeleton.id, 'countdown-task');
});

test('applying a skeleton appends beat drafts without shots or render jobs', async () => {
  const { root, store } = await makeStore('story-skeleton');
  roots.push(root);
  const project = await makeProject(store, 'Skeleton Project');
  updateStory(project, { plannedDurationSeconds: 30 });

  const created = applySkeleton(project, 'delayed-evidence', 6);
  assert.equal(created.length, 6);
  assert.equal(listBeats(project).length, 6);
  assert.ok(created.every((beat) => beat.durationSeconds === 5));
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shots')?.n, 0);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n, 0);
});
