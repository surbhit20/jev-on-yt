import { formatTime } from './time.js';

const SENTENCE_END = /[.!?]["')\]]?$/;

export function chunkSecondsFor(durationSec, rules) {
  for (const r of rules) if (durationSec <= r.maxDurationSec) return r.chunkSec;
  return rules[rules.length - 1].chunkSec;
}

export const chunkId = (i) => 'C' + String(i).padStart(3, '0');
export const chunkIndex = (id) => parseInt(id.slice(1), 10);

export function buildChunks(lines, targetSec, slack) {
  const raw = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (!cur) cur = { start: line.start, end: line.end, texts: [], lineIdx: [i, i] };
    cur.texts.push(line.text);
    cur.end = Math.max(cur.end, line.end);
    cur.lineIdx[1] = i;
    const dur = cur.end - cur.start;
    const atMax = dur >= targetSec * (1 + slack);
    const atSentence = dur >= targetSec * (1 - slack) && SENTENCE_END.test(line.text.trim());
    if (atMax || atSentence) {
      raw.push(cur);
      cur = null;
    }
  });
  if (cur) {
    const last = raw[raw.length - 1];
    if (last && cur.end - cur.start < targetSec * 0.25) {
      last.texts.push(...cur.texts);
      last.end = cur.end;
      last.lineIdx[1] = cur.lineIdx[1];
    } else {
      raw.push(cur);
    }
  }
  return raw.map((c, i) => ({ id: chunkId(i), start: c.start, end: c.end, text: c.texts.join(' '), lineIdx: c.lineIdx }));
}

export function buildWindows(chunks, size, overlap) {
  const windows = [];
  const step = size - overlap;
  for (let s = 0; s < chunks.length; s += step) {
    windows.push(chunks.slice(s, s + size));
    if (s + size >= chunks.length) break;
  }
  return windows;
}

export function windowState(chunks) {
  return chunks.map((c) => `${c.id} [${formatTime(c.start)}] ${c.text}`).join('\n');
}
