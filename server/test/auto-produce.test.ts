import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeStore, bus } from './helpers.js';
import { updateStory, listBeats } from '../src/modules/story.js';
import { listShots } from '../src/modules/shots.js';
import { listTakes } from '../src/modules/takes.js';
import { getTimeline } from '../src/modules/timeline.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { RenderQueue } from '../src/modules/render.js';
import { AutoProduceService } from '../src/modules/auto-produce.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

async function harness(tag: string) {
  const { root, store } = await makeStore(tag); roots.push(root);
  const project = await makeProject(store, tag);
  project.config.default_provider = 'mock';
  const eventBus = bus(); const ffmpeg = new Ffmpeg();
  const registry = new ProviderRegistry(() => store.current, () => store.registry, ffmpeg, null, 'mock', eventBus, join(root, 'mock'));
  registry.refresh();
  const queue = new RenderQueue(() => store, registry, ffmpeg, eventBus, 100);
  const auto = new AutoProduceService(() => store, registry, queue, ffmpeg, eventBus);
  return { project, auto, queue };
}

async function waitUntil(check: () => boolean, timeout = 60_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('auto produce test timed out');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test('story-only project creates real beats and linked shots before rendering', async () => {
  const { project, auto } = await harness('auto-story');
  updateStory(project, { title: '雨夜归途', body: '女孩在雨夜走出车站。她发现遗失的旧伞。天亮前，她把伞送回老人手中。', plannedDurationSeconds: 9 });
  const plan = await auto.buildPlan(project);
  assert.equal(plan.storyPreparation.willCreateBeats, 3);
  assert.equal(plan.storyPreparation.willCreateShots, 3);

  auto.prepareProject(project);
  const beats = listBeats(project); const shots = listShots(project);
  assert.equal(beats.length, 3);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((shot) => shot.storyBeatId), beats.map((beat) => beat.id));
  assert.ok(beats.every((beat) => beat.durationSeconds >= 2 && beat.durationSeconds <= 15));
  assert.ok(new Set(beats.map((beat) => beat.durationSeconds)).size > 1, 'beat timing has persisted rhythm variation');
});

test('mock one-click drives canonical pipeline through export', async () => {
  const { project, auto, queue } = await harness('auto-e2e');
  updateStory(project, { title: '一镜到底', body: '清晨，窗帘被风吹开。', plannedDurationSeconds: 2 });
  const run = auto.start(project, { providerId: 'mock', aspectRatio: '16:9', megapixels: 0.6, skipCompleted: true });
  await waitUntil(() => ['succeeded', 'failed'].includes(auto.getRun(project, run.id)?.status ?? ''));
  const done = auto.getRun(project, run.id)!;
  assert.equal(done.status, 'succeeded', JSON.stringify(done.shots));
  const shot = listShots(project)[0]!;
  assert.equal(listTakes(project, shot.id)[0]?.status, 'selected');
  assert.equal(getTimeline(project).clips[0]?.shotId, shot.id);
  assert.ok(done.exportRelPath);
  await access(project.resolveProjectPath(done.exportRelPath!));
  const jobCount = project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n;
  const rerun = auto.start(project, { providerId: 'mock', aspectRatio: '16:9', megapixels: 0.6, skipCompleted: true });
  await waitUntil(() => ['succeeded', 'failed'].includes(auto.getRun(project, rerun.id)?.status ?? ''));
  assert.equal(auto.getRun(project, rerun.id)?.status, 'succeeded');
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n, jobCount, 'completed paid-like work is never submitted again');
  await queue.forgetProject(project.meta.id);
});

test('real provider start requires fresh explicit confirmation', async () => {
  const { project, auto } = await harness('auto-paid-confirm');
  updateStory(project, { body: '一个测试镜头。' });
  assert.throws(() => auto.start(project, { providerId: 'runninghub', aspectRatio: '16:9', megapixels: 0.6, skipCompleted: true }), /明确确认/);
});
