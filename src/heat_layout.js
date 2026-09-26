const clampPct = (x) => Math.min(100, Math.max(0, x));

// Converts per-chunk heat into progress-bar cells positioned in % of the video duration.
export function heatCells(chunks, heat, durationSec, floor) {
  if (!(durationSec > 0)) return [];
  const cells = [];
  chunks.forEach((c, i) => {
    const h = heat[i] ?? 0;
    if (h < floor) return;
    const left = clampPct((c.start / durationSec) * 100);
    const right = clampPct((c.end / durationSec) * 100);
    if (right <= left) return;
    cells.push({ idx: i, left, width: right - left, alpha: Math.min(1, h) });
  });
  return cells;
}

export function segmentIndexForChunk(segments, idx) {
  return segments.findIndex((s) => idx >= s.from && idx <= s.to);
}
