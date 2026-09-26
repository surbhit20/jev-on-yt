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

// Gaussian smoothing over ±radius chunks; nulls count as 0.
export function smoothGauss(values, radius) {
  if (radius <= 0) return values.map((v) => v ?? 0);
  const sigma = radius / 2 + 0.5;
  return values.map((_, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += (values[j] ?? 0) * w;
      weight += w;
    }
    return sum / weight;
  });
}

// Wave samples for the relevance chart: x at each chunk's midpoint in % of the duration,
// t = height relative to the video's own peak. Heat below `floor`, or below `peakCut` of the
// peak, is flat; the part above `peakCut` is rescaled so peaks rise from the baseline.
export function waveSamples(chunks, heat, durationSec, { smoothRadius, floor, peakCut = 0 }) {
  if (!(durationSec > 0) || !chunks.length) return [];
  const smoothed = smoothGauss(heat, smoothRadius);
  const peak = Math.max(...smoothed);
  if (!(peak >= floor)) return [];
  return chunks.map((c, i) => ({
    x: clampPct(((c.start + c.end) / 2 / durationSec) * 100),
    t: smoothed[i] < floor ? 0 : Math.max(0, (smoothed[i] / peak - peakCut) / (1 - peakCut)),
  }));
}

const r2 = (n) => Number(n.toFixed(2));

// SVG paths in a 100 × height viewBox: `top` is the smooth curve (Catmull-Rom → Bézier),
// `area` closes it down to the baseline across the full width.
export function wavePath(samples, height) {
  const pts = samples.map((s) => [s.x, height * (1 - s.t)]);
  const clampY = (y) => Math.min(height, Math.max(0, y));
  let top = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6)];
    top += ` C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  const area = `M0 ${height} L${top.slice(1)} L100 ${height} Z`;
  return { top, area };
}
