import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeByChunk, smooth, startsFromChapters, findSegments, walkBack, decide,
} from '../src/scoring.js';
import { CONFIG } from '../src/config.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('mergeByChunk averages overlaps and leaves gaps null', () => {
  const r = mergeByChunk(4, [{ C000: 0.2, C001: 0.4 }, null, { C001: 0.8, C002: 1, C003: null }]);
  assert.ok(close(r[0], 0.2) && close(r[1], 0.6) && close(r[2], 1));
  assert.equal(r[3], null);
});

test('smooth renormalizes at the edges and treats null as 0', () => {
  const r = smooth([0, 1, null], [0.25, 0.5, 0.25]);
  assert.ok(close(r[0], 1 / 3) && close(r[1], 0.5) && close(r[2], 1 / 3));
});

test('startsFromChapters marks the chunk containing each chapter start', () => {
  const chunks = [{ start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 90 }];
  assert.deepEqual(startsFromChapters(chunks, [{ start: 0 }, { start: 45 }], 1, 0.3), [1, 1, 0.3]);
  const gap = [{ start: 0, end: 30 }, { start: 40, end: 70 }];
  assert.deepEqual(startsFromChapters(gap, [{ start: 35 }], 1, 0.3), [0.3, 1]);
});

test('findSegments allows a one-chunk gap', () => {
  const segs = findSegments([0, 0.9, 0.8, 0.1, 0.7, 0, 0, 0.6], 0.5, 1);
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].from, segs[0].to], [1, 4]);
  assert.ok(close(segs[0].score, 2.5));
  assert.deepEqual([segs[1].from, segs[1].to], [7, 7]);
});

test('walkBack finds the nearest topic start within range', () => {
  const start = [0.9, 0.1, 0.1, 0.1, 0.1];
  assert.equal(walkBack(3, start, 3, 0.5), 0);
  assert.equal(walkBack(4, start, 3, 0.5), 4);
  assert.equal(walkBack(0, start, 3, 0.5), 0);
});

// 10 chunks of 30 s. `peaks` sets rel values; everything else is 0.05.
function scenario({ peaks, exists = [0.9], bests = [null], start, unknown, highlightOnly = false }) {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ start: i * 30, end: (i + 1) * 30 }));
  const rel = chunks.map((_, i) => peaks[i] ?? 0.05);
  return decide({
    chunks, rel, exists, bests, highlightOnly, config: CONFIG,
    start: start ?? chunks.map(() => 0.1),
    unknown: unknown ?? chunks.map(() => false),
  });
}

test('decide: clear single topic jumps to walked-back start', () => {
  const start = Array.from({ length: 10 }, (_, i) => (i === 4 ? 0.8 : 0.1));
  const d = scenario({ peaks: { 5: 0.9, 6: 0.95, 7: 0.8 }, bests: [6], start });
  assert.equal(d.kind, 'jump');
  assert.equal(d.target.startIdx, 4);
  assert.equal(d.target.time, 4 * 30 - CONFIG.seekPadSec);
  assert.equal(d.heat.length, 10);
});

test('decide: two similar segments fall back to highlight', () => {
  const d = scenario({ peaks: { 1: 0.9, 2: 0.9, 6: 0.9, 7: 0.85 } });
  assert.equal(d.kind, 'highlight');
  assert.equal(d.segments.length, 2);
});

test('decide: best-choice boost can reorder segments', () => {
  const d = scenario({ peaks: { 1: 1.0, 6: 0.55, 7: 0.55 }, bests: [1] });
  assert.equal(d.segments[0].from, 1); // 1.0 * 1.2 = 1.2 > 1.1
});

test('decide: highlight-only never jumps', () => {
  const d = scenario({ peaks: { 5: 0.9, 6: 0.95 }, highlightOnly: true });
  assert.equal(d.kind, 'highlight');
});

test('decide: low exists means absent', () => {
  assert.equal(scenario({ peaks: { 5: 0.9 }, exists: [0.2] }).kind, 'absent');
});

test('decide: no segment above threshold means absent', () => {
  assert.equal(scenario({ peaks: {}, exists: [0.8] }).kind, 'absent');
});

test('decide: middling exists highlights instead of jumping', () => {
  assert.equal(scenario({ peaks: { 5: 0.9, 6: 0.95 }, exists: [0.5] }).kind, 'highlight');
});

test('decide: unknown chunk next to the winner blocks the jump', () => {
  const unknown = Array.from({ length: 10 }, (_, i) => i === 8);
  assert.equal(scenario({ peaks: { 5: 0.9, 6: 0.95, 7: 0.8 }, unknown }).kind, 'highlight');
});
