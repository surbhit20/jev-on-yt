// The pure steps of one search, shared by the extension (app.js) and the evals (runSearch in
// pipeline.js). No Jev calls here, so the page-side app can load it.
import * as scoring from './scoring.js';
import { chunkIndex } from './chunker.js';

// Per-chunk start signal: chapter starts when the video has chapters, else the start_ pass answers.
export function startSignal(chunks, chapters, startAnswers, config) {
  if (chapters.length) return scoring.startsFromChapters(chunks, chapters, config.chapterStart, config.chapterOther);
  return scoring.mergeByChunk(chunks.length, [startAnswers]);
}

// Per-window query answers + start signal → jump / highlight / absent decision.
export function decideFromAnswers({ chunks, perWindow, start, highlightOnly, config }) {
  const rel = scoring.mergeByChunk(chunks.length, perWindow.map((w) => w?.rel));
  return scoring.decide({
    chunks, rel, start,
    bests: perWindow.map((w) => (w?.best ? chunkIndex(w.best) : null)),
    exists: perWindow.map((w) => w?.exists ?? null),
    unknown: rel.map((v) => v == null),
    highlightOnly,
    config,
  });
}

// Transcript lines the refine step reads for a segment: from its walked-back start to its first chunk.
export function refineRange(chunks, target) {
  const s = target.startIdx;
  const e = Math.min(Math.max(target.from, s + 1), chunks.length - 1);
  return { from: chunks[s].lineIdx[0], to: chunks[e].lineIdx[1] };
}

// Seek time for a segment: the refined line when refine picked one, else the segment's padded start.
export function jumpTimeFor(lines, target, lineIdx, config) {
  if (lineIdx != null && lines[lineIdx]) return Math.max(0, lines[lineIdx].start - config.refinePadSec);
  return target.time;
}
