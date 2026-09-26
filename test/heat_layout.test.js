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

import { smoothGauss, waveSamples, wavePath, waveColor } from '../src/heat_layout.js';

const COLORS = [[0, [250, 199, 117]], [0.45, [239, 159, 39]], [0.7, [216, 90, 48]], [1, [212, 83, 126]]];

test('smoothGauss: radius 0 is identity (nulls as 0); a spike spreads symmetrically', () => {
  assert.deepEqual(smoothGauss([0.2, null, 0.5], 0), [0.2, 0, 0.5]);
  const s = smoothGauss([0, 0, 1, 0, 0], 1);
  assert.ok(s[2] > s[1] && s[1] > 0);
  assert.ok(Math.abs(s[1] - s[3]) < 1e-12);
});

test('waveSamples: x at chunk midpoints in %, t normalised to the peak, 0 below the floor', () => {
  const chunks = [{ start: 0, end: 20 }, { start: 20, end: 40 }, { start: 40, end: 60 }, { start: 60, end: 80 }];
  const s = waveSamples(chunks, [0.01, 0.4, 0.8, 0.01], 80, { smoothRadius: 0, floor: 0.04 });
  assert.deepEqual(s.map((p) => p.x), [12.5, 37.5, 62.5, 87.5]);
  assert.deepEqual(s.map((p) => p.t), [0, 0.5, 1, 0]);
});

test('waveSamples: nothing to draw when all heat is below the floor or there is no duration', () => {
  const chunks = [{ start: 0, end: 10 }];
  assert.deepEqual(waveSamples(chunks, [0.02], 10, { smoothRadius: 0, floor: 0.04 }), []);
  assert.deepEqual(waveSamples(chunks, [0.9], 0, { smoothRadius: 0, floor: 0.04 }), []);
});

test('wavePath: closed area on the baseline, peak touches the top, nothing below the baseline', () => {
  const { area, top } = wavePath([{ x: 10, t: 0 }, { x: 50, t: 1 }, { x: 90, t: 0 }], 48);
  assert.ok(area.startsWith('M0 48 L10 48'));
  assert.ok(area.endsWith('L100 48 Z'));
  assert.ok(top.startsWith('M10 48'));
  assert.ok(top.includes(' 50 0'));
  const ys = [...area.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(ys.every((y) => y >= 0 && y <= 48));
});

test('waveColor: interpolates amber to magenta', () => {
  assert.deepEqual(waveColor(0, COLORS), [250, 199, 117]);
  assert.deepEqual(waveColor(1, COLORS), [212, 83, 126]);
  assert.deepEqual(waveColor(0.45, COLORS), [239, 159, 39]);
});
