import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peaksOf, pairSpots, jumpOk, scoreCase, aggregate, percentile } from '../eval/metrics.js';
import { wer, keyTermsKept } from '../eval/wer.js';
import { chapterCases, labelledCases } from '../eval/cases.js';

// 10 chunks of 30 s.
const chunks = Array.from({ length: 10 }, (_, i) => ({ start: i * 30, end: i * 30 + 30 }));
const seg = (startIdx, from, to, score = 1) => ({ startIdx, from, to, score });

test('peaksOf maps segments to times and hides peaks on absent', () => {
  const d = { kind: 'highlight', segments: [seg(1, 2, 3), seg(7, 7, 7)] };
  assert.deepEqual(peaksOf(d, chunks), [{ start: 30, end: 120 }, { start: 210, end: 240 }]);
  assert.deepEqual(peaksOf({ ...d, kind: 'absent' }, chunks), []);
});

test('pairSpots pairs one-to-one by largest overlap', () => {
  const spots = [{ start: 0, end: 100 }, { start: 90, end: 200 }];
  const peaks = [{ start: 80, end: 190 }, { start: 0, end: 50 }];
  assert.deepEqual(pairSpots(spots, peaks), [1, 0]);
  assert.deepEqual(pairSpots([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]), [null]);
});

test('jumpOk allows 30 s early to 60 s late', () => {
  const s = { start: 100 };
  assert.ok(jumpOk(70, s) && jumpOk(160, s));
  assert.ok(!jumpOk(69, s) && !jumpOk(161, s) && !jumpOk(null, s));
});

test('scoreCase: start/end errors, recall, false peaks, jump', () => {
  const c = { spots: [{ start: 40, end: 110 }, { start: 250, end: 280 }], countFalse: true };
  const decision = { kind: 'jump', segments: [seg(1, 2, 3), seg(5, 5, 5)] };
  const s = scoreCase(c, { decision, jumpTime: 45, chunks });
  assert.equal(s.spots[0].startErr, 10);
  assert.equal(s.spots[0].endErr, 10);
  assert.equal(s.spots[1].peak, null);
  assert.equal(s.recall, 0.5);
  assert.equal(s.falsePeaks, 1);
  assert.equal(s.jumpOk, true);
  assert.equal(s.jumped, true);
});

test('scoreCase leaves false peaks out for chapter cases', () => {
  const s = scoreCase({ spots: [{ start: 40, end: 110 }], countFalse: false },
    { decision: { kind: 'highlight', segments: [seg(8, 8, 9)] }, jumpTime: 240, chunks });
  assert.equal(s.falsePeaks, null);
  assert.equal(s.recall, 0);
  assert.equal(s.jumpOk, false);
});

test('scoreCase: absent cases pass only on absent', () => {
  const c = { absent: true, spots: [], countFalse: true };
  assert.deepEqual(
    scoreCase(c, { decision: { kind: 'absent', segments: [seg(1, 1, 1)] }, jumpTime: null, chunks }),
    { kind: 'absent', peaks: [], jumpTime: null, absentOk: true, falsePeaks: 0 },
  );
  const miss = scoreCase(c, { decision: { kind: 'highlight', segments: [seg(1, 1, 1)] }, jumpTime: 30, chunks });
  assert.equal(miss.absentOk, false);
  assert.equal(miss.falsePeaks, 1);
});

test('aggregate rolls up errors, rates and absent passes', () => {
  const a = aggregate([
    { spots: [{ startErr: 10, endErr: 0 }, { startErr: null, endErr: null }], recall: 0.5, falsePeaks: 1, jumpOk: true, jumped: true },
    { spots: [{ startErr: 30, endErr: 20 }], recall: 1, falsePeaks: null, jumpOk: false, jumped: false },
    { absentOk: true, falsePeaks: 0 },
  ]);
  assert.equal(a.cases, 3);
  assert.equal(a.startErr.mean, 20);
  assert.equal(a.startErr.p90, 30);
  assert.equal(a.recall, 0.75);
  assert.equal(a.falsePeaks, 0.5);
  assert.equal(a.jumpAcc, 0.5);
  assert.equal(a.jumpRate, 0.5);
  assert.equal(a.absentPass, 1);
  assert.equal(percentile([], 90), null);
});

test('wer counts word edits against the reference', () => {
  assert.equal(wer('Where does he talk about hill training?', 'where does he talk about hill training'), 0);
  assert.equal(wer('skip to the caffeine part', 'skip to the coffee part'), 0.2);
  assert.equal(wer('a b', ''), 1);
  assert.equal(wer('', ''), 0);
});

test('keyTermsKept matches whole words, multi-word terms in order', () => {
  assert.equal(keyTermsKept('where does he talk about hill training', ['hill training', 'VO2 max']), 0.5);
  assert.equal(keyTermsKept('hilltraining', ['hill']), 0);
  assert.equal(keyTermsKept('x', []), null);
});

test('chapterCases skips generic and short chapters, ends at the next chapter', () => {
  const v = {
    videoId: 'v1', durationSec: 600, lines: [{ start: 0, end: 600, text: 'x' }],
    chapters: [{ title: 'Intro', start: 0 }, { title: '1. Hill training', start: 60 }, { title: 'Tiny', start: 300 },
      { title: 'Nutrition', start: 320 }],
  };
  const cs = chapterCases(v);
  assert.deepEqual(cs.map((c) => [c.query, c.spots[0].start, c.spots[0].end]), [['Hill training', 60, 300], ['Nutrition', 320, 600]]);
  assert.ok(cs.every((c) => c.hideChapters && !c.countFalse));
});

test('labelledCases parses mm:ss and validates', () => {
  const videos = { v1: {} };
  const [a, b] = labelledCases([
    { video: 'v1', query: 'hills', spots: [{ start: '1:00', end: '1:02:03' }] },
    { video: 'v1', query: 'boats', absent: true },
  ], videos);
  assert.deepEqual(a.spots, [{ start: 60, end: 3723 }]);
  assert.ok(a.countFalse && !a.hideChapters);
  assert.equal(b.absent, true);
  assert.throws(() => labelledCases([{ video: 'nope', query: 'x', absent: true }], videos), /no export/);
  assert.throws(() => labelledCases([{ video: 'v1', query: 'x', spots: [{ start: '2:00', end: '1:00' }] }], videos), /ends before/);
  assert.throws(() => labelledCases([{ video: 'v1', query: 'x', spots: [{ start: 'soon', end: '1:00' }] }], videos), /bad time/);
});
