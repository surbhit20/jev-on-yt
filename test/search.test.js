import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSignal, decideFromAnswers, refineRange, jumpTimeFor } from '../src/search.js';
import { runSearch } from '../src/pipeline.js';
import { buildChunks, buildWindows } from '../src/chunker.js';
import { CONFIG } from '../src/config.js';

// 12 lines of 10 s; two lines per 20 s chunk → 6 chunks.
const lines = Array.from({ length: 12 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `line ${i}.` }));
const chunks = buildChunks(lines, 20, 0);

test('startSignal uses chapters when present, else the start pass answers', () => {
  assert.deepEqual(startSignal(chunks, [{ start: 0 }, { start: 45 }], null, CONFIG), [1, 0.3, 1, 0.3, 0.3, 0.3]);
  assert.deepEqual(startSignal(chunks, [], { C002: 0.9 }, CONFIG), [null, null, 0.9, null, null, null]);
});

test('decideFromAnswers finds the relevant span and jumps to it', () => {
  const rel = { C000: 0, C001: 0, C002: 0.9, C003: 0.8, C004: 0, C005: 0 };
  const d = decideFromAnswers({
    chunks, perWindow: [{ rel, best: 'C002', exists: 0.9 }], start: [0, 0, 1, 0, 0, 0], highlightOnly: false, config: CONFIG,
  });
  assert.equal(d.kind, 'jump');
  assert.equal(d.target.from, 2);
  assert.equal(d.target.to, 3);
  assert.equal(d.target.time, 40 - CONFIG.seekPadSec);
});

test('decideFromAnswers reports absent when no window thinks the topic exists', () => {
  const d = decideFromAnswers({
    chunks, perWindow: [{ rel: { C002: 0.9 }, best: null, exists: 0.1 }], start: chunks.map(() => 0),
    highlightOnly: false, config: CONFIG,
  });
  assert.equal(d.kind, 'absent');
});

test('refineRange covers the walked-back start through the first matched chunk', () => {
  assert.deepEqual(refineRange(chunks, { startIdx: 1, from: 3 }), { from: 2, to: 7 });
  assert.deepEqual(refineRange(chunks, { startIdx: 5, from: 5 }), { from: 10, to: 11 });
});

test('jumpTimeFor prefers the refined line and falls back to the segment time', () => {
  assert.equal(jumpTimeFor(lines, { time: 37 }, 5, CONFIG), 50 - CONFIG.refinePadSec);
  assert.equal(jumpTimeFor(lines, { time: 37 }, null, CONFIG), 37);
  assert.equal(jumpTimeFor(lines, { time: 37 }, 99, CONFIG), 37);
});

// Topic in chunks 2–3; start pass marks chunk 2; refine picks line 5.
function fakeCall(log = []) {
  return async (body, label) => {
    log.push(label.split(' ')[0]);
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      const m = id.match(/^(rel|start)_C(\d+)$/);
      if (!m) continue;
      const i = Number(m[2]);
      answers[id] = { noul: m[1] === 'rel' ? (i === 2 || i === 3 ? 0.9 : 0) : (i === 2 ? 1 : 0) };
    }
    if (body.questions.best) answers.best = { choice: 'C002' };
    if (body.questions.exists) answers.exists = { noul: 0.9 };
    if (body.questions.line) answers.line = { choice: 'L0005' };
    return { data: { answers } };
  };
}

test('runSearch runs the start pass without chapters, then refines the top segment', async () => {
  const log = [];
  const windows = buildWindows(chunks, 4, 1);
  const r = await runSearch({ chunks, windows, lines, chapters: [], query: 'q', call: fakeCall(log), config: CONFIG });
  assert.equal(r.decision.kind, 'jump');
  assert.equal(r.decision.target.startIdx, 2);
  assert.equal(r.jumpTime, 50 - CONFIG.refinePadSec);
  assert.ok(log.includes('start'));
  assert.equal(log.at(-1), 'refine');
});

test('runSearch skips the start pass when chapters are given', async () => {
  const log = [];
  await runSearch({
    chunks, windows: [chunks], lines, chapters: [{ start: 40 }], query: 'q', call: fakeCall(log), config: CONFIG,
  });
  assert.ok(!log.includes('start'));
});

test('runSearch refines the top segment even when the decision is highlight', async () => {
  const r = await runSearch({
    chunks, windows: [chunks], lines, chapters: [], query: 'q', highlightOnly: true, call: fakeCall(), config: CONFIG,
  });
  assert.equal(r.decision.kind, 'highlight');
  assert.equal(r.jumpTime, 50 - CONFIG.refinePadSec);
});
