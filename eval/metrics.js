// Scores one search result against its true spots, and rolls results up. Pure.

export const JUMP_WINDOW = { beforeSec: 30, afterSec: 60 };

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

// Peaks as time ranges: walked-back start through the end of the last matched chunk.
export function peaksOf(decision, chunks) {
  if (decision.kind === 'absent') return [];
  return decision.segments.map((s) => ({ start: chunks[s.startIdx].start, end: chunks[s.to].end }));
}

// One-to-one pairing, greedy by overlap: each spot gets the free peak it overlaps most, or none.
export function pairSpots(spots, peaks) {
  const pairs = [];
  spots.forEach((s, si) => peaks.forEach((p, pi) => {
    const o = overlap(s, p);
    if (o > 0) pairs.push({ si, pi, o });
  }));
  pairs.sort((a, b) => b.o - a.o);
  const bySpot = new Array(spots.length).fill(null);
  const used = new Set();
  for (const { si, pi } of pairs) {
    if (bySpot[si] != null || used.has(pi)) continue;
    bySpot[si] = pi;
    used.add(pi);
  }
  return bySpot;
}

export function jumpOk(jumpTime, spot, win = JUMP_WINDOW) {
  return jumpTime != null && jumpTime >= spot.start - win.beforeSec && jumpTime <= spot.start + win.afterSec;
}

// c: { spots: [{start, end}] (seconds), absent?, countFalse? }
export function scoreCase(c, { decision, jumpTime, chunks }) {
  const peaks = peaksOf(decision, chunks);
  const out = { kind: decision.kind, peaks, jumpTime };
  if (c.absent) {
    return { ...out, absentOk: decision.kind === 'absent', falsePeaks: peaks.length };
  }
  const bySpot = pairSpots(c.spots, peaks);
  const spots = c.spots.map((s, i) => {
    const p = bySpot[i] == null ? null : peaks[bySpot[i]];
    return { ...s, peak: p, startErr: p ? Math.abs(p.start - s.start) : null, endErr: p ? Math.abs(p.end - s.end) : null };
  });
  const paired = new Set(bySpot.filter((i) => i != null));
  return {
    ...out,
    spots,
    recall: spots.filter((s) => s.peak).length / spots.length,
    falsePeaks: c.countFalse ? peaks.filter((p, i) => !paired.has(i) && !c.spots.some((s) => overlap(s, p) > 0)).length : null,
    jumpOk: jumpOk(jumpTime, c.spots[0]),
    jumped: decision.kind === 'jump',
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const rate = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

// scores: scoreCase outputs of cases that ran (errored cases left out by the caller).
export function aggregate(scores) {
  const present = scores.filter((s) => s.spots);
  const absent = scores.filter((s) => s.absentOk != null);
  const errs = (k) => present.flatMap((s) => s.spots.map((x) => x[k]).filter((v) => v != null));
  const starts = errs('startErr');
  const ends = errs('endErr');
  const falses = scores.map((s) => s.falsePeaks).filter((v) => v != null);
  return {
    cases: scores.length,
    startErr: { mean: mean(starts), p90: percentile(starts, 90) },
    endErr: { mean: mean(ends), p90: percentile(ends, 90) },
    recall: mean(present.map((s) => s.recall)),
    falsePeaks: mean(falses),
    jumpAcc: rate(present.map((s) => s.jumpOk)),
    jumpRate: rate(present.map((s) => s.jumped)),
    absentPass: rate(absent.map((s) => s.absentOk)),
  };
}
