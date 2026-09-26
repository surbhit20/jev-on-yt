import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';

test('thresholds are ordered sensibly', () => {
  assert.ok(CONFIG.absentT < CONFIG.foundT);
  assert.ok(CONFIG.windowOverlap < CONFIG.windowSize);
  assert.ok(CONFIG.margin >= 1);
});

test('chunk rules ascend and end with Infinity', () => {
  const r = CONFIG.chunkRules;
  for (let i = 1; i < r.length; i++) assert.ok(r[i].maxDurationSec > r[i - 1].maxDurationSec);
  assert.equal(r.at(-1).maxDurationSec, Infinity);
});

test('smoothing kernel sums to 1', () => {
  assert.equal(CONFIG.kernel.reduce((a, b) => a + b, 0), 1);
});
