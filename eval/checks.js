// Checks on the eval itself: fake-answer baselines, error ranges, tune/holdout split, label
// consistency, run-to-run noise, and where the judge disagrees with the labels. Pure.
import { scorePeaks, aggregate, pairSpots } from './metrics.js';

// Small seeded RNG so random baselines and error ranges are the same on every run.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h;
}

// ~30% of cases are held back for a final check. Keyed on video + query, so reordering files
// or adding cases never moves an existing case between the two sets.
export const HOLDOUT_SHARE = 0.3;
export const inHoldout = (c) => fnv1a(`${c.video}|${c.query.trim().toLowerCase()}`) % 100 < HOLDOUT_SHARE * 100;
export function splitCases(cases, split) {
  if (split === 'all') return cases;
  return cases.filter((c) => (split === 'holdout') === inHoldout(c));
}

// Fake answers with known outcomes. If "perfect" doesn't score perfectly, the metrics are broken.
export function baselineScores(cases, durationOf, seed = 7) {
  const rand = rng(seed);
  const scored = cases.filter((c) => !c.unlabelled);
  const perfect = scored.map((c) => scorePeaks(c, c.absent
    ? { kind: 'absent', peaks: [], jumpTime: null }
    : { kind: 'jump', peaks: c.spots.map((s) => ({ ...s })), jumpTime: c.spots[0].start }));
  const random = scored.map((c) => {
    const dur = durationOf(c);
    const lens = c.spots.map((s) => s.end - s.start);
    const len = Math.min(dur, lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 60);
    const peaks = Array.from({ length: Math.max(1, c.spots.length) }, () => {
      const start = rand() * Math.max(0, dur - len);
      return { start, end: start + len };
    }).sort((a, b) => a.start - b.start);
    return scorePeaks(c, { kind: 'highlight', peaks, jumpTime: peaks[0].start });
  });
  const whole = scored.map((c) => scorePeaks(c, { kind: 'highlight', peaks: [{ start: 0, end: durationOf(c) }], jumpTime: 0 }));
  return { perfect, random, whole };
}

// Hard checks on the perfect baseline; random and whole-video are floors Jev has to beat.
export function checkPerfect(a) {
  const want = [
    ['start error mean', a.startErr.mean, 0], ['end error mean', a.endErr.mean, 0], ['recall', a.recall, 1],
    ['false peaks', a.falsePeaks, 0], ['jump acc', a.jumpAcc, 1], ['absent pass', a.absentPass, 1],
  ];
  return want.filter(([, got]) => got != null).map(([name, got, expected]) => ({ name, got, expected, ok: Math.abs(got - expected) < 1e-9 }));
}

// Error ranges: resample the cases with replacement and take the middle 95% of each metric.
export const CI_METRICS = [
  ['startErr', 'mean'], ['startErr', 'p90'], ['endErr', 'mean'], ['endErr', 'p90'],
  ['recall'], ['falsePeaks'], ['jumpAcc'], ['jumpRate'], ['absentPass'],
];
const get = (a, path) => path.reduce((o, k) => o?.[k], a);

export function bootstrap(scores, aggregateFn = aggregate, { n = 1000, seed = 11 } = {}) {
  if (scores.length < 2) return null;
  const rand = rng(seed);
  const samples = Array.from({ length: n }, () => aggregateFn(scores.map(() => scores[Math.floor(rand() * scores.length)])));
  const out = {};
  for (const path of CI_METRICS) {
    const xs = samples.map((a) => get(a, path)).filter((v) => v != null).sort((x, y) => x - y);
    if (xs.length < n * 0.5) continue;
    out[path.join('.')] = [xs[Math.floor(xs.length * 0.025)], xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.975))]];
  }
  return out;
}

// Run-to-run noise: the spread of each aggregate metric over repeated fresh runs.
export function noise(aggs) {
  const out = {};
  for (const path of CI_METRICS) {
    const xs = aggs.map((a) => get(a, path)).filter((v) => v != null);
    if (xs.length < 2) continue;
    out[path.join('.')] = { min: Math.min(...xs), max: Math.max(...xs), spread: Math.max(...xs) - Math.min(...xs) };
  }
  return out;
}

// Your labels vs a second labelling of the same queries (relabel.json). The gap is the floor:
// start/end errors below it are noise, not progress.
export function labelConsistency(first, second) {
  const key = (c) => `${c.video}|${c.query.trim().toLowerCase()}`;
  const byKey = new Map(first.map((c) => [key(c), c]));
  const startDiffs = [];
  const endDiffs = [];
  const issues = [];
  let pairs = 0;
  for (const b of second) {
    const a = byKey.get(key(b));
    if (!a) {
      issues.push(`"${b.query}": not in labelled.json`);
      continue;
    }
    pairs++;
    if (!!a.absent !== !!b.absent) {
      issues.push(`"${b.query}": absent in one labelling only`);
      continue;
    }
    if (a.spots.length !== b.spots.length) issues.push(`"${b.query}": ${a.spots.length} spot(s) vs ${b.spots.length}`);
    const bySpot = pairSpots(a.spots, b.spots);
    a.spots.forEach((s, i) => {
      if (bySpot[i] == null) {
        issues.push(`"${b.query}": spot at ${Math.round(s.start)}s has no match`);
        return;
      }
      startDiffs.push(Math.abs(s.start - b.spots[bySpot[i]].start));
      endDiffs.push(Math.abs(s.end - b.spots[bySpot[i]].end));
    });
  }
  const mean = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const p90 = (xs) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.ceil(0.9 * xs.length) - 1] : null);
  return { pairs, start: { mean: mean(startDiffs), p90: p90(startDiffs) }, end: { mean: mean(endDiffs), p90: p90(endDiffs) }, issues };
}

const overlaps = (a, b) => Math.min(a.end, b.end) > Math.max(a.start, b.start);

// Every place the judge and the hand labels disagree, with the judge's reason, to read by hand.
export function disagreements(pairs) {
  const out = [];
  for (const { id, c, score, judged } of pairs) {
    score.peaks.forEach((p, i) => {
      const human = c.spots.some((s) => overlaps(s, p));
      const j = judged.peaks[i];
      if (human !== j.relevant) {
        out.push({ id, query: c.query, what: 'peak', at: p.start, human: human ? 'on topic' : 'off topic', judge: j.verdict, reason: j.reason });
      }
    });
    if (c.absent && judged.spots.length) {
      out.push({ id, query: c.query, what: 'absent', at: judged.spots[0].start, human: 'absent', judge: `${judged.spots.length} spot(s)`, reason: '' });
    }
    if (!c.absent && judged.landing && score.jumpOk !== judged.jumpOk) {
      out.push({ id, query: c.query, what: 'jump', at: score.jumpTime, human: score.jumpOk ? 'ok' : 'wrong', judge: judged.landing.verdict, reason: judged.landing.reason });
    }
    for (const s of c.spots) {
      if (!judged.spots.some((j) => overlaps(s, j))) out.push({ id, query: c.query, what: 'spot', at: s.start, human: 'spot', judge: 'not found', reason: '' });
    }
    for (const j of judged.spots) {
      if (!c.spots.some((s) => overlaps(s, j))) out.push({ id, query: c.query, what: 'spot', at: j.start, human: 'no spot', judge: 'spot', reason: '' });
    }
  }
  return out;
}
