import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callJev, JevError, mapLimit } from '../src/jev_client.js';

const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s === 'throw') throw new Error('offline');
    return response(s, { answers: { ok: true } });
  };
  fn.calls = calls;
  return fn;
}

const opts = (fetchImpl, delays = []) => ({
  apiKey: 'k', endpoint: 'https://x/v1', fetchImpl, tries: 4, baseMs: 500,
  sleep: async (ms) => { delays.push(ms); },
});

test('success sends auth and JSON body', async () => {
  const f = fakeFetch([200]);
  const r = await callJev({ a: 1 }, opts(f));
  assert.deepEqual(r.data, { answers: { ok: true } });
  assert.equal(r.attempts, 1);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(f.calls[0].init.body, '{"a":1}');
});

test('429 then 200 retries once with 500 ms', async () => {
  const delays = [];
  const r = await callJev({}, opts(fakeFetch([429, 200]), delays));
  assert.equal(r.attempts, 2);
  assert.deepEqual(delays, [500]);
});

test('529 four times gives up with doubling backoff', async () => {
  const delays = [];
  await assert.rejects(callJev({}, opts(fakeFetch([529]), delays)), (e) => e instanceof JevError && e.status === 529);
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test('401 fails immediately', async () => {
  const delays = [];
  const f = fakeFetch([401]);
  await assert.rejects(callJev({}, opts(f, delays)), (e) => e.status === 401);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(delays, []);
});

test('network error has status "network"', async () => {
  await assert.rejects(callJev({}, opts(fakeFetch(['throw']))), (e) => e.status === 'network');
});

test('mapLimit preserves order and respects the limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, x));
    active--;
    return x * 10 + i;
  });
  assert.deepEqual(out, [50, 11, 42, 23, 34]);
  assert.equal(peak, 2);
});
