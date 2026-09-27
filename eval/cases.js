// Loads exported videos and builds eval cases from chapters and hand labels.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTimestamp } from '../src/time.js';
import * as chunker from '../src/chunker.js';

// Chapter titles that name a part of the video rather than a topic.
const GENERIC = /^(intro(duction)?|outro|sponsor(ed|ship)?( segment)?|ad|q ?& ?a|questions|conclusion|summary|recap|wrap[- ]?up|ending|end|credits|start|welcome|thanks?( for watching)?)$/i;
export const MIN_CHAPTER_SEC = 30;

export function loadVideos(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    out[v.videoId] = v;
  }
  return out;
}

// Chunks and windows exactly as the extension builds them.
export function prepareVideo(v, config) {
  const durationSec = Math.max(v.durationSec || 0, v.lines.at(-1)?.end || 0);
  const chunkSec = chunker.chunkSecondsFor(durationSec, config.chunkRules);
  const chunks = chunker.buildChunks(v.lines, chunkSec, config.sentenceSlack);
  const windows = chunker.buildWindows(chunks, config.windowSize, config.windowOverlap);
  return { ...v, durationSec, chunks, windows };
}

const cleanTitle = (t) => String(t ?? '').replace(/^\s*(\d+[.):]|[-–•])\s*/, '').trim();

// One case per topical chapter: title = query, chapter = the one true spot. The pipeline runs with
// chapters hidden, since chapter starts would otherwise feed its start signal.
export function chapterCases(v) {
  const chapters = v.chapters ?? [];
  const durationSec = Math.max(v.durationSec || 0, v.lines.at(-1)?.end || 0);
  return chapters.flatMap((ch, i) => {
    const end = chapters[i + 1]?.start ?? durationSec;
    const query = cleanTitle(ch.title);
    if (!query || GENERIC.test(query) || end - ch.start < MIN_CHAPTER_SEC) return [];
    return [{
      id: `${v.videoId}#ch${i}`, source: 'chapters', video: v.videoId, query,
      spots: [{ start: ch.start, end }], hideChapters: true, countFalse: false,
    }];
  });
}

const toSec = (t, where) => {
  const s = typeof t === 'number' ? t : parseTimestamp(t);
  if (s == null) throw new Error(`${where}: bad time ${JSON.stringify(t)} (use mm:ss or h:mm:ss)`);
  return s;
};

// labelled.json: [{ video, query, spots: [{ start: "mm:ss", end: "mm:ss" }] } | { video, query, absent: true }]
export function labelledCases(list, videos) {
  return list.map((c, i) => {
    const where = `labelled.json #${i} "${c.query}"`;
    if (!c.video || !c.query) throw new Error(`${where}: needs video and query`);
    if (!videos[c.video]) throw new Error(`${where}: no export for video ${c.video} in eval/data/videos/`);
    const base = { id: `${c.video}#L${i}`, source: 'labelled', video: c.video, query: c.query, hideChapters: false, countFalse: true };
    if (c.absent) return { ...base, absent: true, spots: [] };
    if (!c.spots?.length) throw new Error(`${where}: needs spots, or absent: true`);
    const spots = c.spots.map((s) => ({ start: toSec(s.start, where), end: toSec(s.end, where) }));
    for (const s of spots) if (s.end <= s.start) throw new Error(`${where}: a spot ends before it starts`);
    return { ...base, spots };
  });
}

export function loadLabelled(file, videos) {
  if (!existsSync(file)) return [];
  return labelledCases(JSON.parse(readFileSync(file, 'utf8')), videos);
}
