import { parseTimestamp } from './time.js';

// Depth-first search for every value stored under `key`, in document order.
export function findAll(root, key) {
  const out = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
    const vals = Array.isArray(node) ? node : Object.values(node);
    for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
  }
  return out;
}

export function findTranscriptParams(data) {
  for (const ep of findAll(data, 'getTranscriptEndpoint')) {
    if (ep && typeof ep.params === 'string') return ep.params;
  }
  return null;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function fillEnds(lines, fallbackEnd) {
  lines.sort((a, b) => a.start - b.start);
  lines.forEach((l, i) => {
    if (l.end > l.start) return;
    const next = lines[i + 1]?.start;
    l.end = next > l.start ? next : (fallbackEnd ?? l.start + 2);
  });
  return lines;
}

export function parseTranscriptResponse(json) {
  const lines = [];
  for (const seg of findAll(json, 'transcriptSegmentRenderer')) {
    const start = Number(seg?.startMs) / 1000;
    const end = Number(seg?.endMs) / 1000;
    const runs = seg?.snippet?.runs;
    const text = clean(runs ? runs.map((r) => r.text ?? '').join('') : seg?.snippet?.simpleText);
    if (!text || !Number.isFinite(start)) continue;
    lines.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return fillEnds(lines);
}

export function parseChapters(data) {
  const seen = new Set();
  const out = [];
  for (const c of findAll(data, 'chapterRenderer')) {
    const start = Number(c?.timeRangeStartMillis) / 1000;
    if (!Number.isFinite(start) || seen.has(start)) continue;
    seen.add(start);
    const title = c.title?.simpleText ?? (c.title?.runs ?? []).map((r) => r.text).join('');
    out.push({ title, start });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function parseJson3(json) {
  const lines = [];
  for (const ev of json?.events ?? []) {
    if (!ev?.segs?.length) continue;
    const start = Number(ev.tStartMs) / 1000;
    const end = (Number(ev.tStartMs) + Number(ev.dDurationMs ?? 0)) / 1000;
    const text = clean(ev.segs.map((s) => s.utf8 ?? '').join(''));
    if (!text || !Number.isFinite(start)) continue;
    lines.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return fillEnds(lines);
}

export function linesFromPanel(rows, durationSec) {
  const lines = [];
  for (const row of rows) {
    const start = parseTimestamp(row.ts);
    const text = clean(row.text);
    if (start == null || !text) continue;
    lines.push({ start, end: start, text });
  }
  return fillEnds(lines, durationSec);
}
