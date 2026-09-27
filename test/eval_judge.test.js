import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPeakRequest, readPeak, buildLandingRequest, readLanding, buildSpotsRequest, readSpots,
  makeJudge, judgeCase, agreement, judgeAggregate,
} from '../eval/judge.js';

// 60 lines of 10 s; 20 chunks of 30 s.
const lines = Array.from({ length: 60 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `line ${i}` }));
const chunks = Array.from({ length: 20 }, (_, i) => ({
  id: 'C' + String(i).padStart(3, '0'), start: i * 30, end: i * 30 + 30, text: `chunk ${i}`, lineIdx: [i * 3, i * 3 + 2],
}));
const user = (req) => req.messages.at(-1).content;

test('peak request shows only the lines under the peak, with a strict schema', () => {
  const req = buildPeakRequest('hills', lines, { start: 100, end: 130 });
  assert.match(user(req), /L0010 \[1:40\] line 10\nL0011 \[1:50\] line 11\nL0012 \[2:00\] line 12\n/);
  assert.doesNotMatch(user(req), /line 9\b|line 13\b/);
  assert.equal(req.response_format.json_schema.strict, true);
  assert.deepEqual(readPeak({ verdict: 'discusses', reason: 'r' }).relevant, true);
  assert.deepEqual(readPeak({ verdict: 'passing', reason: 'r' }).relevant, false);
});

test('landing request marks the jump line and reads beginsAt back as seconds', () => {
  const req = buildLandingRequest('hills', lines, 200);
  assert.match(user(req), />>> JUMP HERE >>> L0020 \[3:20\]/);
  assert.match(user(req), /L0011 \[1:50\]/); // 90 s before
  assert.doesNotMatch(user(req), /L0010 /);
  const r = readLanding({ verdict: 'late', beginsAt: 'L0015', reason: 'r' }, lines);
  assert.deepEqual([r.ok, r.beginsAt], [false, 150]);
  assert.equal(readLanding({ verdict: 'at_start', beginsAt: 'nonsense', reason: '' }, lines).beginsAt, null);
});

test('spots request lists every chunk; readSpots maps ids to times and drops bad ids', () => {
  const req = buildSpotsRequest('hills', chunks);
  assert.match(user(req), /C019 \[9:30\] chunk 19/);
  assert.deepEqual(readSpots({ spots: [{ from: 'C002', to: 'C004' }, { from: 'C009', to: 'C008' }, { from: 'C099', to: 'C001' }] }, chunks),
    [{ start: 60, end: 150 }, { start: 240, end: 300 }]);
});

test('makeJudge posts the model with the request and parses the JSON answer, through the cache', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"discusses","reason":"x"}' } }] }) };
  };
  const keys = [];
  const cached = async (key, fn) => { keys.push(key); return fn(); };
  const judge = makeJudge({ apiKey: 'k', model: 'm1', endpoint: 'http://j', cached, fetchImpl });
  const out = await judge(buildPeakRequest('q', lines, { start: 0, end: 20 }));
  assert.deepEqual(out, { verdict: 'discusses', reason: 'x' });
  assert.equal(sent.body.model, 'm1');
  assert.equal(sent.auth, 'Bearer k');
  assert.ok(keys[0].startsWith('judge|http://j|m1|'));
  const noKey = makeJudge({ apiKey: '', cached, fetchImpl });
  await assert.rejects(noKey({}), /OPENAI_API_KEY/);
});

// Judge answers: peaks at 0–60 on topic, others not; landing late with discussion from L0003; spots C000–C001 and C010.
async function fakeJudge(req) {
  const name = req.response_format.json_schema.name;
  if (name === 'peak') return { verdict: /\bL0000\b/.test(user(req)) ? 'discusses' : 'absent', reason: '' };
  if (name === 'landing') return { verdict: 'late', beginsAt: 'L0003', reason: '' };
  return { spots: [{ from: 'C000', to: 'C001' }, { from: 'C010', to: 'C010' }], reason: '' };
}

test('judgeCase combines peak, landing and spot verdicts', async () => {
  const peaks = [{ start: 0, end: 60 }, { start: 400, end: 450 }];
  const j = await judgeCase({ judge: fakeJudge, query: 'q', video: { lines, chunks }, peaks, jumpTime: 45 });
  assert.equal(j.precision, 0.5);
  assert.equal(j.falsePeaks, 1);
  assert.equal(j.jumpOk, false);
  assert.equal(j.landingErr, 15);
  assert.equal(j.recall, 0.5);
  assert.deepEqual(j.missed, [{ start: 300, end: 330 }]);
  const none = await judgeCase({ judge: fakeJudge, query: 'q', video: { lines, chunks }, peaks: [], jumpTime: null });
  assert.equal(none.precision, null);
  assert.equal(none.landing, null);
});

test('agreement compares the judge with hand labels', () => {
  const pairs = [
    {
      c: { spots: [{ start: 0, end: 60 }] },
      score: { peaks: [{ start: 0, end: 60 }, { start: 400, end: 450 }], jumpOk: true },
      judged: { peaks: [{ relevant: true }, { relevant: true }], jumpOk: true, spots: [{ start: 10, end: 50 }, { start: 300, end: 330 }] },
    },
    { c: { absent: true, spots: [] }, score: { peaks: [] }, judged: { peaks: [], jumpOk: null, spots: [] } },
  ];
  const a = agreement(pairs);
  assert.equal(a.peaks, 0.5);
  assert.equal(a.jump, 1);
  assert.equal(a.absent, 1);
  assert.equal(a.spotRecall, 1);
  assert.equal(a.spotPrecision, 0.5);
});

test('judgeAggregate averages over judged cases', () => {
  const a = judgeAggregate([
    { precision: 1, falsePeaks: 0, jumpOk: true, landingErr: -10, recall: 1, missed: [] },
    { precision: 0.5, falsePeaks: 1, jumpOk: null, landingErr: null, recall: null, missed: [{}, {}] },
  ]);
  assert.deepEqual(a, { cases: 2, precision: 0.75, falsePeaks: 0.5, jumpAcc: 1, landingErr: 10, recall: 1, missed: 1 });
});
