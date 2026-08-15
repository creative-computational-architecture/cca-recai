import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiText } from '../src/ai.js';

test('AI raporunu ASCII cikisa zorlar', () => {
  const result = asciiText('CPU yuku dusuk; darbo\u011faz\u0131 \u00e7\u00f6z. \u0130stanbul, \u00c7orlu.');
  assert.equal(result, 'CPU yuku dusuk; darbogazi coz. Istanbul, Corlu.');
  assert.doesNotMatch(result, /[^\x00-\x7F]/);
});
