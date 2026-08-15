import test from 'node:test';
import assert from 'node:assert/strict';
import { removeDirectoryContents } from '../src/audit.js';

test('workspace gibi genis bir kok dizini temizlemeyi reddeder', async () => {
  await assert.rejects(
    () => removeDirectoryContents(process.cwd()),
    /Genis veya guvensiz/,
  );
});

