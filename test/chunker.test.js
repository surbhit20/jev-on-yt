import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkSecondsFor, buildChunks, chunkId, chunkIndex, buildWindows, windowState,
} from '../src/chunker.js';
import { CONFIG } from '../src/config.js';

const makeLines = (count, step = 4, text = (i) => `word${i}`) =>
  Array.from({ length: count }, (_, i) => ({ start: i * step, end: (i + 1) * step, text: text(i) }));

test('chunkSecondsFor uses duration rules', () => {
  assert.equal(chunkSecondsFor(600, CONFIG.chunkRules), 15);
  assert.equal(chunkSecondsFor(1200, CONFIG.chunkRules), 15);
  assert.equal(chunkSecondsFor(3600, CONFIG.chunkRules), 30);
  assert.equal(chunkSecondsFor(4 * 3600, CONFIG.chunkRules), 45);
});

test('chunkId / chunkIndex round trip', () => {
  assert.equal(chunkId(7), 'C007');
  assert.equal(chunkId(1234), 'C1234');
  assert.equal(chunkIndex('C014'), 14);
});

test('buildChunks: no punctuation closes at the upper bound', () => {
  const lines = makeLines(100);
  const chunks = buildChunks(lines, 30, 0.4);
  assert.deepEqual(chunks[0].lineIdx, [0, 10]); // 44 s >= 42 s
  for (const c of chunks.slice(0, -1)) assert.ok(c.end - c.start <= 42 + 4);
  // contiguous coverage of every line
  assert.equal(chunks[0].lineIdx[0], 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].lineIdx[0], chunks[i - 1].lineIdx[1] + 1);
  assert.equal(chunks.at(-1).lineIdx[1], 99);
  assert.deepEqual(chunks.map((c) => c.id).slice(0, 3), ['C000', 'C001', 'C002']);
  assert.equal(chunks.map((c) => c.text).join(' '), lines.map((l) => l.text).join(' '));
});

test('buildChunks: prefers a sentence end inside the slack band', () => {
  const lines = makeLines(40, 4, (i) => (i === 5 ? 'end of thought.' : `w${i}`));
  const chunks = buildChunks(lines, 30, 0.4);
  assert.deepEqual(chunks[0].lineIdx, [0, 5]); // 24 s >= 18 s and ends with "."
});

test('buildChunks: a tiny remainder merges into the previous chunk', () => {
  const lines = makeLines(12); // 11 lines close the first chunk, 1 line (4 s) remains
  const chunks = buildChunks(lines, 30, 0.4);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].lineIdx, [0, 11]);
  assert.equal(chunks[0].end, 48);
});

test('buildChunks: empty input', () => {
  assert.deepEqual(buildChunks([], 30, 0.4), []);
});

test('buildWindows: size and 1-chunk overlap', () => {
  const chunks = Array.from({ length: 65 }, (_, i) => ({ id: chunkId(i) }));
  const w = buildWindows(chunks, 30, 1);
  assert.deepEqual(w.map((x) => x.length), [30, 30, 7]);
  assert.equal(w[0].at(-1).id, w[1][0].id);
  assert.equal(w.at(-1).at(-1).id, 'C064');
  assert.equal(buildWindows(chunks.slice(0, 30), 30, 1).length, 1);
  assert.deepEqual(buildWindows(chunks.slice(0, 31), 30, 1).map((x) => x.length), [30, 2]);
  assert.deepEqual(buildWindows([], 30, 1), []);
});

test('buildWindows: overlap >= size terminates and covers the last chunk', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({ id: chunkId(i) }));
  const w = buildWindows(chunks, 2, 2);
  assert.ok(w.length > 0 && w.length < Infinity);
  assert.equal(w.at(-1).at(-1).id, 'C004');
});

test('windowState formats one line per chunk', () => {
  const s = windowState([
    { id: 'C000', start: 0, text: 'hello' },
    { id: 'C001', start: 750, text: 'world' },
  ]);
  assert.equal(s, 'C000 [0:00] hello\nC001 [12:30] world');
});
