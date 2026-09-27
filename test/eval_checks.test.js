import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rng, inHoldout, splitCases, baselineScores, checkPerfect, bootstrap, noise, labelConsistency, disagreements,
} from '../eval/checks.js';
import { aggregate } from '../eval/metrics.js';

const cases = [
  { id: 'a', video: 'v', query: 'hills', spots: [{ start: 60, end: 180 }, { start: 400, end: 460 }], countFalse: true },
  { id: 'b', video: 'v', query: 'nutrition', spots: [{ start: 200, end: 300 }], countFalse: false },
  { id: 'c', video: 'v', query: 'boats', absent: true, spots: [], countFalse: true },
  { id: 'd', video: 'v', query: 'free', spots: [], unlabelled: true },
];
const dur = () => 600;

test('rng is deterministic per seed', () => {
  const a = rng(3);
  const b = rng(3);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('holdout split is stable, ~30%, and ignores case order, index and letter case', () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ video: 'v', query: `query ${i}` }));
  const held = many.filter(inHoldout).length;
  assert.ok(held > 240 && held < 360, `${held}`);
  assert.equal(inHoldout({ video: 'v', query: 'Hills ' }), inHoldout({ video: 'v', query: 'hills' }));
  const tune = splitCases(many, 'tune');
  const hold = splitCases(many, 'holdout');
  assert.equal(tune.length + hold.length, 1000);
  assert.equal(splitCases(many, 'all').length, 1000);
});

test('perfect baseline scores perfectly; floors score worse', () => {
  const b = baselineScores(cases, dur);
  assert.equal(b.perfect.length, 3);
  const checks = checkPerfect(aggregate(b.perfect));
  assert.ok(checks.length >= 5 && checks.every((x) => x.ok), JSON.stringify(checks));
  const whole = aggregate(b.whole);
  assert.equal(whole.recall, 0.75); // one peak pairs with one spot, so 'hills' (2 spots) gets 1/2
  assert.equal(whole.absentPass, 0);
  assert.ok(whole.startErr.mean > 0);
  assert.ok(aggregate(b.random).jumpAcc < 1);
});

test('checkPerfect flags a broken metric', () => {
  const a = aggregate(baselineScores(cases, dur).perfect);
  const bad = checkPerfect({ ...a, recall: 0.9 });
  assert.equal(bad.find((x) => x.name === 'recall').ok, false);
});

test('bootstrap gives a range around the value and is null for tiny sets', () => {
  const scores = Array.from({ length: 20 }, (_, i) => ({
    spots: [{ startErr: i, endErr: i }], recall: 1, falsePeaks: null, jumpOk: i % 2 === 0, jumped: true,
  }));
  const ci = bootstrap(scores);
  const [lo, hi] = ci.jumpAcc;
  assert.ok(lo < 0.5 && hi > 0.5 && lo >= 0 && hi <= 1);
  assert.deepEqual(ci.recall, [1, 1]);
  assert.deepEqual(bootstrap(scores), ci);
  assert.equal(bootstrap(scores.slice(0, 1)), null);
});

test('noise reports the spread over repeated runs', () => {
  const n = noise([{ recall: 0.8, startErr: { mean: 10 } }, { recall: 0.7, startErr: { mean: 14 } }, { recall: 0.75, startErr: { mean: 12 } }]);
  assert.ok(Math.abs(n.recall.spread - 0.1) < 1e-9);
  assert.deepEqual(n['startErr.mean'], { min: 10, max: 14, spread: 4 });
});

test('labelConsistency measures start/end gaps and lists mismatches', () => {
  const first = cases.filter((c) => !c.unlabelled);
  const second = [
    { video: 'v', query: 'Hills', spots: [{ start: 66, end: 170 }] },
    { video: 'v', query: 'nutrition', spots: [{ start: 196, end: 310 }] },
    { video: 'v', query: 'boats', spots: [{ start: 10, end: 20 }] },
    { video: 'v', query: 'unknown', absent: true, spots: [] },
  ];
  const lc = labelConsistency(first, second);
  assert.equal(lc.pairs, 3);
  assert.equal(lc.start.mean, 5);
  assert.equal(lc.end.mean, 10);
  assert.ok(lc.issues.some((x) => /hills.*2 spot\(s\) vs 1/i.test(x)));
  assert.ok(lc.issues.some((x) => /boats.*absent/.test(x)));
  assert.ok(lc.issues.some((x) => /unknown.*not in labelled/.test(x)));
});

test('disagreements lists every peak, jump, absent and spot mismatch', () => {
  const list = disagreements([
    {
      id: 'a', c: cases[0],
      score: { peaks: [{ start: 60, end: 180 }, { start: 500, end: 550 }], jumpOk: true, jumpTime: 58 },
      judged: {
        peaks: [{ relevant: true, verdict: 'discusses' }, { relevant: true, verdict: 'discusses', reason: 'talks hills' }],
        landing: { verdict: 'late', reason: 'mid-answer' }, jumpOk: false,
        spots: [{ start: 60, end: 180 }, { start: 500, end: 550 }],
      },
    },
    { id: 'c', c: cases[2], score: { peaks: [] }, judged: { peaks: [], landing: null, jumpOk: null, spots: [{ start: 10, end: 30 }] } },
  ]);
  assert.deepEqual(list.map((x) => `${x.id} ${x.what} ${x.at}`), [
    'a peak 500', 'a jump 58', 'a spot 400', 'a spot 500', 'c absent 10', 'c spot 10',
  ]);
  assert.equal(list[0].reason, 'talks hills');
});
