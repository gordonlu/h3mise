import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { directorStyleAiContext, resolveDirectorStyle } from '../src/modules/director-styles.js';
import { createShot } from '../src/modules/shots.js';
import { compilePrompt } from '../src/modules/prompt.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('familiar work names resolve to generic director presets', () => {
  assert.equal(resolveDirectorStyle('想要武林外传风格').preset?.id, 'ensemble-wuxia-sitcom');
  assert.equal(resolveDirectorStyle('邵氏电影风格').preset?.id, 'hk-studio-wuxia-1970s');
  assert.equal(resolveDirectorStyle('老港片警匪感').preset?.id, 'hk-heroic-crime-1990s');
  assert.equal(resolveDirectorStyle('霓虹港片夜景').preset?.id, 'hk-neon-noir');
});

test('AI receives structured intent, directives, and anti-copy constraints', async () => {
  const { root, store } = await makeStore('director-style-ai');
  roots.push(root);
  const project = await makeProject(store, 'Style Project');
  project.config.visual_style = '武林外传风格';
  const context = directorStyleAiContext(project);
  assert.match(context, /ensemble-wuxia-sitcom/);
  assert.match(context, /rapid dialogue handoffs/);
  assert.match(context, /不在最终 Prompt 保留被模仿作品名/);
});

test('deterministic H3 compilation uses resolved directives instead of the work name', async () => {
  const { root, store } = await makeStore('director-style-compile');
  roots.push(root);
  const project = await makeProject(store, 'Style Compile');
  project.config.visual_style = '武林外传风格';
  const shot = createShot(project, { title: 'Dialogue', durationSeconds: 6 });
  const prompt = compilePrompt(project, shot.id, 't2va');
  assert.match(prompt.text, /live-action ensemble martial-arts sitcom/);
  assert.doesNotMatch(prompt.text, /武林外传/);
});

test('Ref2VA compilation also includes resolved director directives', async () => {
  const { root, store } = await makeStore('director-style-ref2va');
  roots.push(root);
  const project = await makeProject(store, 'Style Ref2VA');
  project.config.visual_style = '霓虹港片';
  const shot = createShot(project, { title: 'Neon street', durationSeconds: 6 });
  const prompt = compilePrompt(project, shot.id, 'ref2va');
  assert.match(prompt.text, /live-action Hong Kong urban noir/);
  assert.doesNotMatch(prompt.text, /霓虹港片/);
});
