import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heatCells, segmentIndexForChunk } from '../src/heat_layout.js';

const chunks = [
  { start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 90 }, { start: 90, end: 130 },
];

test('heatCells: percent positions, floor filter, alpha capped at 1', () => {
  const cells = heatCells(chunks, [0.1, 0.5, 1.2, 0.2], 120, 0.2);
  assert.deepEqual(cells.map((c) => c.idx), [1, 2, 3]);
  assert.equal(cells[0].left, 25);
  assert.equal(cells[0].width, 25);
  assert.equal(cells[1].alpha, 1);
  assert.equal(cells[2].left, 75);
  assert.equal(cells[2].width, 25); // clamped at 100%
});

test('heatCells: no duration means no cells; null heat is skipped', () => {
  assert.deepEqual(heatCells(chunks, [1, 1, 1, 1], 0, 0.2), []);
  assert.deepEqual(heatCells(chunks, [null, null, null, null], 120, 0.2), []);
});

test('segmentIndexForChunk', () => {
  const segs = [{ from: 5, to: 7 }, { from: 1, to: 2 }];
  assert.equal(segmentIndexForChunk(segs, 6), 0);
  assert.equal(segmentIndexForChunk(segs, 1), 1);
  assert.equal(segmentIndexForChunk(segs, 3), -1);
});
