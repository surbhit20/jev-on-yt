import { chunkIndex } from './chunker.js';

export function mergeByChunk(n, maps) {
  const sum = new Array(n).fill(0);
  const cnt = new Array(n).fill(0);
  for (const m of maps) {
    if (!m) continue;
    for (const [id, v] of Object.entries(m)) {
      if (typeof v !== 'number') continue;
      const i = chunkIndex(id);
      if (i >= 0 && i < n) {
        sum[i] += v;
        cnt[i]++;
      }
    }
  }
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : null));
}

export function smooth(values, kernel) {
  const half = Math.floor(kernel.length / 2);
  return values.map((_, i) => {
    let acc = 0;
    let w = 0;
    kernel.forEach((k, j) => {
      const idx = i + j - half;
      if (idx < 0 || idx >= values.length) return;
      acc += (values[idx] ?? 0) * k;
      w += k;
    });
    return w ? acc / w : 0;
  });
}

export function startsFromChapters(chunks, chapters, hi, lo) {
  const out = chunks.map(() => lo);
  for (const ch of chapters) {
    const i = chunks.findIndex((c) => c.end > ch.start);
    if (i >= 0) out[i] = hi;
  }
  return out;
}

export function findSegments(rel, relT, gap) {
  const segs = [];
  let from = -1;
  let last = -1;
  const flush = () => {
    if (from < 0) return;
    let score = 0;
    for (let i = from; i <= last; i++) score += rel[i] ?? 0;
    segs.push({ from, to: last, score });
    from = -1;
  };
  rel.forEach((v, i) => {
    if ((v ?? 0) < relT) return;
    if (from >= 0 && i - last - 1 > gap) flush();
    if (from < 0) from = i;
    last = i;
  });
  flush();
  return segs;
}

export function walkBack(from, start, maxSteps, startT) {
  for (let k = 0; k <= maxSteps && from - k >= 0; k++) {
    if ((start?.[from - k] ?? 0) >= startT) return from - k;
  }
  return from;
}

export function decide({ chunks, rel, start, bests, exists, unknown, highlightOnly, config }) {
  const heat = smooth(rel, config.kernel);
  const known = exists.filter((v) => typeof v === 'number');
  const maxExists = known.length ? Math.max(...known) : 0;
  const bestSet = bests.filter((b) => b != null);

  const segments = findSegments(rel, config.relT, config.gapChunks)
    .map((s) => {
      const boosted = bestSet.some((b) => b >= s.from && b <= s.to);
      const startIdx = walkBack(s.from, start, config.walkBackChunks, config.startT);
      return {
        ...s,
        score: boosted ? s.score * config.bestBoost : s.score,
        startIdx,
        time: Math.max(0, chunks[startIdx].start - config.seekPadSec),
      };
    })
    .sort((a, b) => b.score - a.score);

  const base = { heat, segments, maxExists, target: null };
  if (maxExists < config.absentT || !segments.length) return { ...base, kind: 'absent' };

  const [s0, s1] = segments;
  const clearWinner = !s1 || s0.score >= config.margin * s1.score;
  const touchesUnknown = unknown.some((u, i) => u && i >= s0.startIdx - 1 && i <= s0.to + 1);
  if (!highlightOnly && maxExists >= config.foundT && clearWinner && !touchesUnknown) {
    return { ...base, kind: 'jump', target: s0 };
  }
  return { ...base, kind: 'highlight' };
}
