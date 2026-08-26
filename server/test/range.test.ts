import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from '../src/http/range.js';

test('byte ranges support closed, open-ended, and suffix forms', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('byte ranges reject unsatisfiable input without misreading malformed ranges', () => {
  assert.equal(parseByteRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=20-10', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=0-1,4-5', 100), null);
  assert.equal(parseByteRange('garbage', 100), null);
});
