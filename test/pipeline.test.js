import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, runStart, runRefine } from '../src/pipeline.js';
import { JevError } from '../src/jev_client.js';

const windows = [
  [{ id: 'C000', start: 0, text: 'a' }, { id: 'C001', start: 30, text: 'b' }],
  [{ id: 'C001', start: 30, text: 'b' }, { id: 'C002', start: 60, text: 'c' }],
];

// Answers every question: rel = 0.1 * chunk number, start = 0.5, best = last chunk.
function fakeCall({ failWindow = -1, status = 529 } = {}) {
  let n = 0;
  return async (body) => {
    const idx = n++;
    if (body.state.startsWith('C001') && failWindow === 1) throw new JevError(status, 'x');
    if (failWindow === 'all') throw new JevError(status, 'x');
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      const m = id.match(/^(rel|start)_C(\d+)$/);
      if (m) answers[id] = { noul: m[1] === 'rel' ? Number(m[2]) / 10 : 0.5 };
    }
    const ids = Object.keys(body.questions.best?.criteria ?? {});
    if (ids.length) answers.best = { choice: ids.at(-1) };
    if (body.questions.exists) answers.exists = { noul: 0.8 };
    if (body.questions.line) answers.line = { choice: Object.keys(body.questions.line.criteria)[1] };
    return { data: { answers }, ms: 1, idx };
  };
}

const base = { windows, query: 'q', limit: 10, model: 'm' };

test('runQuery merges nothing, returns per-window answers', async () => {
  const r = await runQuery({ ...base, call: fakeCall() });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.perWindow[0], { rel: { C000: 0, C001: 0.1 }, best: 'C001', exists: 0.8 });
  assert.deepEqual(r.perWindow[1].rel, { C001: 0.1, C002: 0.2 });
});

test('runQuery tolerates one failed window', async () => {
  const r = await runQuery({ ...base, call: fakeCall({ failWindow: 1 }) });
  assert.deepEqual(r.failed, [1]);
  assert.equal(r.perWindow[1], null);
});

test('runQuery throws on 401 and when all windows fail', async () => {
  await assert.rejects(runQuery({ ...base, call: fakeCall({ failWindow: 1, status: 401 }) }), (e) => e.status === 401);
  await assert.rejects(runQuery({ ...base, call: fakeCall({ failWindow: 'all' }) }), (e) => e.status === 529);
});

test('runStart merges windows into one map', async () => {
  const r = await runStart({ windows, call: fakeCall(), limit: 10, model: 'm' });
  assert.deepEqual(r.start, { C000: 0.5, C001: 0.5, C002: 0.5 });
});

test('runRefine returns an absolute line index, null on failure', async () => {
  const lines = [{ start: 0, text: 'a' }, { start: 1, text: 'b' }];
  assert.equal(await runRefine({ lines, offset: 40, query: 'q', call: fakeCall(), model: 'm', maxLines: 255 }), 41);
  assert.equal(await runRefine({ lines, offset: 40, query: 'q', call: async () => { throw new Error('x'); }, model: 'm', maxLines: 255 }), null);
});

test('stops fan-out after fatal 401 error', async () => {
  let callCount = 0;
  const call = async () => {
    callCount++;
    throw new JevError(401, 'unauthorized');
  };
  await assert.rejects(runQuery({ windows, query: 'q', limit: 1, model: 'm', call }), (e) => e.status === 401);
  assert.equal(callCount, 1);
});
