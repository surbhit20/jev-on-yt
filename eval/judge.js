// LLM judge (OpenAI) for the evals: is each peak on topic, where should the jump have landed, and
// where does the video really discuss the query. Prompt builders and readers are pure; the call is injected.
import { formatTime } from '../src/time.js';
import { windowState } from '../src/chunker.js';

export const JUDGE_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_JUDGE_MODEL = 'gpt-4.1';
export const LANDING_CONTEXT = { beforeSec: 90, afterSec: 120 };

const SYSTEM = 'You grade a video search tool. You read transcript excerpts of a YouTube video and judge them '
  + 'strictly against the user\'s query. Substantive discussion counts; a passing mention, a teaser '
  + '("later we\'ll talk about…") or a single word does not. Answer only in the requested JSON.';

const lineId = (i) => 'L' + String(i).padStart(4, '0');
const renderLines = (lines, from, to, mark) => lines.slice(from, to + 1)
  .map((l, k) => `${from + k === mark ? '>>> JUMP HERE >>> ' : ''}${lineId(from + k)} [${formatTime(l.start)}] ${l.text}`)
  .join('\n');

function linesIn(lines, start, end) {
  let from = lines.findIndex((l) => l.end > start);
  if (from < 0) from = lines.length - 1;
  let to = from;
  while (to + 1 < lines.length && lines[to + 1].start < end) to++;
  return { from, to };
}

const schema = (name, properties) => ({
  type: 'json_schema',
  json_schema: {
    name, strict: true,
    schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
  },
});
const REASON = { type: 'string', description: 'One short sentence.' };

// 1. Peak relevance: does this stretch discuss the query?
export function buildPeakRequest(query, lines, peak) {
  const { from, to } = linesIn(lines, peak.start, peak.end);
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Query: ${JSON.stringify(query)}\n\nExcerpt (${formatTime(peak.start)}–${formatTime(peak.end)}):\n`
        + `${renderLines(lines, from, to)}\n\nDoes this excerpt substantively discuss the query?` },
    ],
    response_format: schema('peak', {
      verdict: { type: 'string', enum: ['discusses', 'passing', 'absent'] },
      reason: REASON,
    }),
  };
}
export const readPeak = (a) => ({ relevant: a.verdict === 'discusses', verdict: a.verdict, reason: a.reason });

// 2. Jump landing: does playback start where the answer begins?
export function buildLandingRequest(query, lines, jumpTime, ctx = LANDING_CONTEXT) {
  const { from, to } = linesIn(lines, jumpTime - ctx.beforeSec, jumpTime + ctx.afterSec);
  const mark = Math.max(from, linesIn(lines, jumpTime, jumpTime).from);
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Query: ${JSON.stringify(query)}\n\nThe tool starts playback at the line marked `
        + `">>> JUMP HERE >>>" (${formatTime(jumpTime)}).\n\n${renderLines(lines, from, to, mark)}\n\n`
        + 'Grade the landing. at_start: at or just before (a few seconds of lead-in) the line where discussion of the query begins. '
        + 'early: well before it, the viewer sits through unrelated talk. late: after the discussion already began. '
        + 'off_topic: the query is not discussed around here. beginsAt: the line id where the discussion begins, or null.' },
    ],
    response_format: schema('landing', {
      verdict: { type: 'string', enum: ['at_start', 'early', 'late', 'off_topic'] },
      beginsAt: { type: ['string', 'null'] },
      reason: REASON,
    }),
  };
}
export function readLanding(a, lines) {
  const m = /^L(\d+)$/.exec(a.beginsAt ?? '');
  const i = m ? Number(m[1]) : null;
  return { ok: a.verdict === 'at_start', verdict: a.verdict, beginsAt: i != null && lines[i] ? lines[i].start : null, reason: a.reason };
}

// 3. Every spot in the whole video, by chunk ids (catches what the tool missed).
export function buildSpotsRequest(query, chunks) {
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Query: ${JSON.stringify(query)}\n\nFull transcript in chunks:\n${windowState(chunks)}\n\n`
        + 'List every stretch that substantively discusses the query, as ranges of chunk ids (from and to inclusive, '
        + 'from ≤ to). Merge adjacent chunks into one range. Return an empty list if the video never discusses it.' },
    ],
    response_format: schema('spots', {
      spots: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
      },
      reason: REASON,
    }),
  };
}
export function readSpots(a, chunks) {
  const idx = (id) => chunks.findIndex((c) => c.id === id);
  return (a.spots ?? []).flatMap((s) => {
    const i = idx(s.from);
    const j = idx(s.to);
    if (i < 0 || j < 0) return [];
    return [{ start: chunks[Math.min(i, j)].start, end: chunks[Math.max(i, j)].end }];
  });
}

// OpenAI chat completions with a strict JSON schema. `cached(key, fetcher)` wraps it for the disk cache.
export function makeJudge({ apiKey, model = DEFAULT_JUDGE_MODEL, endpoint = JUDGE_ENDPOINT, cached, fetchImpl = globalThis.fetch }) {
  return async (req) => cached(`judge|${endpoint}|${model}|${JSON.stringify(req)}`, async () => {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for --judge)');
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...req }),
    });
    if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const msg = (await res.json()).choices?.[0]?.message;
    if (!msg?.content) throw new Error(`judge gave no answer${msg?.refusal ? `: ${msg.refusal}` : ''}`);
    return JSON.parse(msg.content);
  });
}

const overlaps = (a, b) => Math.min(a.end, b.end) > Math.max(a.start, b.start);

// All judge verdicts for one search result. peaks: from metrics.peaksOf.
export async function judgeCase({ judge, query, video, peaks, jumpTime }) {
  const peakVerdicts = await Promise.all(peaks.map(async (p) => readPeak(await judge(buildPeakRequest(query, video.lines, p)))));
  const landing = jumpTime == null ? null : readLanding(await judge(buildLandingRequest(query, video.lines, jumpTime)), video.lines);
  const spots = readSpots(await judge(buildSpotsRequest(query, video.chunks)), video.chunks);
  const found = spots.filter((s) => peaks.some((p) => overlaps(s, p)));
  return {
    peaks: peakVerdicts,
    precision: peaks.length ? peakVerdicts.filter((v) => v.relevant).length / peaks.length : null,
    falsePeaks: peakVerdicts.filter((v) => !v.relevant).length,
    landing,
    jumpOk: landing ? landing.ok : null,
    landingErr: landing?.beginsAt != null ? jumpTime - landing.beginsAt : null,
    spots,
    recall: spots.length ? found.length / spots.length : null,
    missed: spots.filter((s) => !found.includes(s)),
  };
}

// How far the judge agrees with hand labels (labelled cases): per peak, per spot, per jump, per absent topic.
export function agreement(pairs) {
  const peak = [];
  const jump = [];
  const absent = [];
  let humanSpots = 0;
  let humanFound = 0;
  let judgeSpots = 0;
  let judgeTrue = 0;
  for (const { c, score, judged } of pairs) {
    score.peaks.forEach((p, i) => peak.push(c.spots.some((s) => overlaps(s, p)) === judged.peaks[i].relevant));
    if (c.absent) absent.push(judged.spots.length === 0);
    else if (judged.jumpOk != null) jump.push(score.jumpOk === judged.jumpOk);
    humanSpots += c.spots.length;
    humanFound += c.spots.filter((s) => judged.spots.some((j) => overlaps(s, j))).length;
    judgeSpots += judged.spots.length;
    judgeTrue += judged.spots.filter((j) => c.spots.some((s) => overlaps(s, j))).length;
  }
  const rate = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
  return {
    cases: pairs.length,
    peaks: rate(peak), peakCount: peak.length,
    jump: rate(jump),
    absent: rate(absent),
    spotRecall: humanSpots ? humanFound / humanSpots : null, // human spots the judge also found
    spotPrecision: judgeSpots ? judgeTrue / judgeSpots : null, // judge spots a human also marked
  };
}

export function judgeAggregate(list) {
  const vals = (k) => list.map((j) => j[k]).filter((v) => v != null).map(Number);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const errs = vals('landingErr').map(Math.abs);
  return {
    cases: list.length,
    precision: mean(vals('precision')),
    falsePeaks: mean(vals('falsePeaks')),
    jumpAcc: mean(vals('jumpOk')),
    landingErr: mean(errs),
    recall: mean(vals('recall')),
    missed: mean(list.map((j) => j.missed.length)),
  };
}
