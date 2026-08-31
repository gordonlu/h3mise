import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsoluteImportPath } from '../src/modules/media.js';

test('local media import accepts Windows drive and UNC absolute paths', () => {
  assert.equal(isAbsoluteImportPath('C:\\Users\\Ada\\video.mp4'), true);
  assert.equal(isAbsoluteImportPath('D:/media/video.mp4'), true);
  assert.equal(isAbsoluteImportPath('\\\\studio-nas\\shots\\video.mp4'), true);
  assert.equal(isAbsoluteImportPath('shots\\video.mp4'), false);
});
