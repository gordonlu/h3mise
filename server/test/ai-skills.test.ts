import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AIService } from '../src/modules/ai.js';
import { cleanupTempRoot, makeTempRoot } from './helpers.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

function service(skillsDir: string | null): AIService {
  return new AIService({ baseUrl: null, apiKey: null, model: null }, skillsDir);
}

test('bundled AI skills load the lightweight MiniMax H3 director package', async () => {
  const skills = await service(null).loadSkills();
  assert.deepEqual(skills.map((skill) => skill.id), [
    'minimax-h3-video-director',
    'minimax-h3-director-patterns',
    'minimax-h3-storyboard-patterns',
  ]);
  assert.ok(skills.every((skill) => !skill.content.includes('(skill file')));
  assert.ok(skills[0]?.content.includes('Decide what matters, then control only that.'));
});

test('a local core skill override keeps bundled reference fallbacks available', async () => {
  const root = makeTempRoot('ai-skills');
  roots.push(root);
  const skillDir = join(root, 'minimax-h3-video-director');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), 'local H3 director override', 'utf8');

  const skills = await service(root).loadSkills();
  assert.equal(skills[0]?.content, 'local H3 director override');
  assert.ok(skills[1]?.content.includes('Motion Hierarchy'));
  assert.ok(skills[2]?.content.includes('Panels Are Not Cuts'));
});
