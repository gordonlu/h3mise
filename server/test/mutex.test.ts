// Keyed mutex — serialization semantics backing the render-submit gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedMutex } from '../src/modules/mutex.js';

test('same key serializes; different keys run concurrently', async () => {
  const gate = createKeyedMutex();
  let running = 0;
  let maxRunning = 0;
  let counter = 0;
  const work = (ms: number) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, ms));
    counter++;
    running--;
  };

  await Promise.all(Array.from({ length: 5 }, () => gate('k', work(10))));
  assert.equal(counter, 5);
  assert.equal(maxRunning, 1);

  maxRunning = 0;
  await Promise.all([gate('a', work(20)), gate('b', work(5))]);
  assert.equal(maxRunning, 2);
});

test('a failing task neither poisons the chain nor leaks the key', async () => {
  const gate = createKeyedMutex();
  await assert.rejects(() => gate('k', async () => { throw new Error('boom'); }), /boom/);
  let ran = false;
  await gate('k', async () => { ran = true; });
  assert.equal(ran, true);
});
