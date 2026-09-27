// JEV_API_KEY=… [OPENAI_API_KEY=…] [JEV_ENDPOINT=…] [JUDGE_MODEL=…] npm run eval -- [--judge] [--check]
//   [--only chapters|labelled|queries|voice] [--split tune|holdout|all] [--video <id>] [--case <text>]
//   [--fresh] [--offline] [--repeat <n>] [--set <config key>=<number>] [--compare <results.json>]
// See eval/README.md.
// Runs the extension's search against the real Jev API on exported transcripts and scores it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { callJev } from '../src/jev_client.js';
import { runSearch } from '../src/pipeline.js';
import { parseQuery } from '../src/query.js';
import { callTranscribe } from '../src/openai_transcribe.js';
import { formatTime } from '../src/time.js';
import { loadVideos, prepareVideo, chapterCases, loadLabelled, loadQueries, labelledCases } from './cases.js';
import { scoreCase, aggregate, jumpOk } from './metrics.js';
import { wer, keyTermsKept } from './wer.js';
import { baselineScores, checkPerfect, bootstrap, splitCases, noise, labelConsistency, disagreements } from './checks.js';
import { makeJudge, judgeCase, judgeAggregate, agreement, DEFAULT_JUDGE_MODEL, JUDGE_ENDPOINT } from './judge.js';

const ROOT = new URL('.', import.meta.url).pathname;
const DIR = {
  videos: join(ROOT, 'data/videos'),
  voice: join(ROOT, 'data/voice'),
  labelled: join(ROOT, 'cases/labelled.json'),
  queries: join(ROOT, 'cases/queries.json'),
  relabel: join(ROOT, 'cases/relabel.json'),
  cache: join(ROOT, 'cache'),
  results: join(ROOT, 'results'),
};

function parseArgs(argv) {
  const a = {
    only: null, video: null, case: null, fresh: false, offline: false, judge: false, check: false, compare: null,
    split: 'tune', repeat: 1, set: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'fresh' || k === 'offline' || k === 'judge' || k === 'check') a[k] = true;
    else if (k === 'set') a.set.push(argv[++i]);
    else if (k === 'repeat') a.repeat = Number(argv[++i]);
    else if (k in a) a[k] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (a.only && !['chapters', 'labelled', 'queries', 'voice'].includes(a.only)) throw new Error('--only takes chapters, labelled, queries or voice');
  if (!['tune', 'holdout', 'all'].includes(a.split)) throw new Error('--split takes tune, holdout or all');
  if (!Number.isInteger(a.repeat) || a.repeat < 1) throw new Error('--repeat takes a whole number ≥ 1');
  if (a.only === 'queries') a.judge = true; // unlabelled queries have nothing to score without the judge
  return a;
}

// Disk cache keyed by the request, so re-scoring after a threshold change costs no API calls.
function makeCache(args) {
  mkdirSync(DIR.cache, { recursive: true });
  const stats = { hits: 0, calls: 0, misses: 0 };
  async function cached(key, fetcher) {
    const file = join(DIR.cache, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
    if (!args.fresh && existsSync(file)) {
      stats.hits++;
      return JSON.parse(readFileSync(file, 'utf8'));
    }
    if (args.offline) {
      stats.misses++;
      throw Object.assign(new Error('not cached (--offline)'), { status: 'offline' });
    }
    stats.calls++;
    const value = await fetcher();
    writeFileSync(file, JSON.stringify(value));
    return value;
  }
  return { cached, stats };
}

const JEV_ENDPOINT = process.env.JEV_ENDPOINT || CONFIG.endpoint;

// Repeat 0 is the normal cached answer; repeats 1..n-1 are separate fresh samples (cached too, so a
// noise measurement can be re-read offline).
function makeJevCall(cache, misses, repeat = 0) {
  const apiKey = process.env.JEV_API_KEY;
  return async (body) => {
    try {
      return await cache.cached(`jev|${JEV_ENDPOINT}|${JSON.stringify(body)}${repeat ? `|repeat ${repeat}` : ''}`, async () => {
        if (!apiKey) throw Object.assign(new Error('JEV_API_KEY is not set'), { status: 'nokey' });
        const r = await callJev(body, { apiKey, endpoint: JEV_ENDPOINT, tries: CONFIG.retryTries, baseMs: CONFIG.retryBaseMs });
        return { data: r.data };
      });
    } catch (e) {
      misses.count++;
      throw e;
    }
  };
}

// Search as the extension would: parse the user's words, then the shared pipeline.
async function search(video, text, { hideChapters, call }) {
  const parsed = parseQuery(text);
  const query = parsed.kind === 'search' ? parsed.query : text;
  const misses = { count: 0 };
  const r = await runSearch({
    chunks: video.chunks, windows: video.windows, lines: video.lines,
    chapters: hideChapters ? [] : (video.chapters ?? []),
    query, highlightOnly: false, call: call(misses), config: CONFIG,
  });
  if (misses.count || r.failed.length) {
    throw new Error(`${misses.count} request(s) failed or uncached, failed windows ${JSON.stringify(r.failed)}`);
  }
  return { ...r, query };
}

const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d));
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

function printCases(rows) {
  console.log(`\n${pad('case', 16)} ${pad('query', 34)} ${pad('kind', 9)} ${pad('start±s', 8)} ${pad('end±s', 8)} ${pad('recall', 6)} ${pad('false', 5)} jump`);
  for (const r of rows) {
    if (r.error) {
      console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ERROR ${r.error}`);
      continue;
    }
    const s = r.score;
    if (!s.spots && s.absentOk == null) {
      console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ${pad(s.kind, 9)} ${s.peaks.length} peak(s)${s.jumpTime == null ? '' : `, top at ${formatTime(s.jumpTime)}`}`);
      continue;
    }
    if (s.absentOk != null) {
      console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ${pad(s.kind, 9)} ${pad('', 8)} ${pad('', 8)} ${pad(s.absentOk ? 'absent ✓' : 'absent ✗', 6)} ${pad(s.falsePeaks, 5)}`);
      continue;
    }
    const errs = (k) => s.spots.map((x) => f(x[k])).join('/');
    console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ${pad(s.kind, 9)} ${pad(errs('startErr'), 8)} ${pad(errs('endErr'), 8)} ` +
      `${pad(pct(s.recall), 6)} ${pad(s.falsePeaks ?? '', 5)} ${s.jumpOk ? '✓' : '✗'} ${s.jumpTime == null ? '' : formatTime(s.jumpTime)}`);
  }
}

function printAggregate(name, a, prev, ci) {
  if (!a?.cases) return;
  const d = (k, sub, scale = 1, digits = 1) => {
    const now = sub ? a[k][sub] : a[k];
    const was = prev ? (sub ? prev[k]?.[sub] : prev[k]) : null;
    return now != null && was != null ? ` (${now - was >= 0 ? '+' : ''}${((now - was) * scale).toFixed(digits)})` : '';
  };
  // 95% range from resampling the cases: how far the number could move with a different set of cases.
  const r = (path, fmt) => (ci?.[path] ? ` [${fmt(ci[path][0])}–${fmt(ci[path][1])}]` : '');
  const sec = (v) => (v == null ? '–' : `${f(v, 1)}s`);
  console.log(`\n${name}: ${a.cases} cases`);
  console.log(`  start error  mean ${sec(a.startErr.mean)}${r('startErr.mean', sec)}${d('startErr', 'mean')}  p90 ${sec(a.startErr.p90)}${d('startErr', 'p90')}`);
  console.log(`  end error    mean ${sec(a.endErr.mean)}${r('endErr.mean', sec)}${d('endErr', 'mean')}  p90 ${sec(a.endErr.p90)}${d('endErr', 'p90')}`);
  console.log(`  recall       ${pct(a.recall)}${r('recall', pct)}${d('recall', null, 100, 0)}`);
  if (a.falsePeaks != null) console.log(`  false peaks  ${f(a.falsePeaks, 2)}${r('falsePeaks', (v) => f(v, 2))} per case${d('falsePeaks', null, 1, 2)}`);
  console.log(`  jump acc     ${pct(a.jumpAcc)}${r('jumpAcc', pct)}${d('jumpAcc', null, 100, 0)}   (jump rate ${pct(a.jumpRate)})`);
  if (a.absentPass != null) console.log(`  absent pass  ${pct(a.absentPass)}${r('absentPass', pct)}${d('absentPass', null, 100, 0)}`);
}

function printJudge(rows) {
  const judged = rows.filter((r) => r.judge || r.judgeError);
  if (!judged.length) return;
  console.log(`\njudge\n${pad('case', 16)} ${pad('query', 34)} ${pad('on-topic', 9)} ${pad('landing', 16)} ${pad('recall', 6)} missed`);
  for (const r of judged) {
    if (r.judgeError) {
      console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ERROR ${r.judgeError}`);
      continue;
    }
    const j = r.judge;
    const onTopic = j.peaks.length ? `${j.peaks.length - j.falsePeaks}/${j.peaks.length}` : '–';
    const landing = j.landing ? `${j.landing.verdict}${j.landingErr == null ? '' : ` ${j.landingErr >= 0 ? '+' : ''}${Math.round(j.landingErr)}s`}` : '–';
    const missed = j.missed.map((s) => formatTime(s.start)).join(' ');
    console.log(`${pad(r.id, 16)} ${pad(r.query, 34)} ${pad(onTopic, 9)} ${pad(landing, 16)} ${pad(pct(j.recall), 6)} ${missed}`);
  }
}

function printJudgeAggregate(name, a, prev) {
  if (!a?.cases) return;
  const d = (k, scale = 1, digits = 0) => (a[k] != null && prev?.[k] != null
    ? ` (${a[k] - prev[k] >= 0 ? '+' : ''}${((a[k] - prev[k]) * scale).toFixed(digits)})` : '');
  console.log(`\njudge · ${name}: ${a.cases} cases`);
  console.log(`  precision    ${pct(a.precision)}${d('precision', 100)}   false peaks ${f(a.falsePeaks, 2)} per case${d('falsePeaks', 1, 2)}`);
  console.log(`  jump acc     ${pct(a.jumpAcc)}${d('jumpAcc', 100)}   landing off by ${f(a.landingErr, 1)}s${d('landingErr', 1, 1)}`);
  console.log(`  recall       ${pct(a.recall)}${d('recall', 100)}   missed ${f(a.missed, 2)} spot(s) per case${d('missed', 1, 2)}`);
}

function printAgreement(a) {
  if (!a?.cases) return;
  console.log(`\njudge vs your labels (${a.cases} cases): peaks ${pct(a.peaks)} of ${a.peakCount}, jump ${pct(a.jump)}, ` +
    `absent ${pct(a.absent)}, spots found ${pct(a.spotRecall)}, spots correct ${pct(a.spotPrecision)}`);
  const low = [a.peaks, a.jump, a.absent, a.spotRecall, a.spotPrecision].some((v) => v != null && v < 0.8);
  if (low) console.log('  Agreement under 80%: read the judged numbers with care, or tighten the judge prompts.');
}

function printDisagreements(list) {
  if (!list.length) return;
  console.log(`\njudge disagrees with your labels (${list.length}): check who is right, then fix the label or the judge prompt`);
  for (const x of list) {
    console.log(`  ${pad(x.id, 16)} ${pad(x.query, 30)} ${pad(x.what, 6)} ${pad(x.at == null ? '–' : formatTime(x.at), 8)} ` +
      `you: ${pad(x.human, 10)} judge: ${pad(x.judge, 12)} ${x.reason ?? ''}`);
  }
}

// --set relevance threshold etc. for one run, e.g. --set relT=0.6. Numbers only, existing keys only.
function applySets(sets) {
  const applied = {};
  for (const kv of sets) {
    const m = /^(\w+)=(-?[\d.]+)$/.exec(kv ?? '');
    if (!m || typeof CONFIG[m[1]] !== 'number') throw new Error(`--set ${kv}: use <numeric CONFIG key>=<number>`);
    applied[m[1]] = { from: CONFIG[m[1]], to: Number(m[2]) };
    CONFIG[m[1]] = Number(m[2]);
  }
  return applied;
}

// --check: no API calls. Fake answers through the metrics, plus your labels against a relabelling.
function runChecks(cases, videos) {
  const scored = cases.filter((c) => !c.unlabelled);
  if (!scored.length) {
    console.log('--check: no labelled or chapter cases yet.');
    return true;
  }
  const b = baselineScores(scored, (c) => videos[c.video].durationSec);
  const perfect = checkPerfect(aggregate(b.perfect));
  const broken = perfect.filter((x) => !x.ok);
  console.log(`\nmetric check: perfect answers (peaks = your labels) on ${scored.length} cases`);
  for (const x of perfect) console.log(`  ${x.ok ? '✓' : '✗'} ${pad(x.name, 17)} ${f(x.got, 2)} (expected ${x.expected})`);
  console.log(broken.length ? '  METRICS ARE BROKEN: fix eval/metrics.js before trusting any number.' : '  Metrics score a perfect answer as perfect.');
  printAggregate('floor: random peaks (Jev must beat this on every line)', aggregate(b.random));
  printAggregate('floor: one peak covering the whole video', aggregate(b.whole));

  if (existsSync(DIR.relabel)) {
    const first = scored.filter((c) => c.source === 'labelled');
    const second = labelledCases(JSON.parse(readFileSync(DIR.relabel, 'utf8')), videos);
    const lc = labelConsistency(first, second);
    console.log(`\nyour labels vs relabel.json (${lc.pairs} queries)`);
    console.log(`  start differs by ${f(lc.start.mean, 1)}s on average (p90 ${f(lc.start.p90, 1)}s); end by ${f(lc.end.mean, 1)}s (p90 ${f(lc.end.p90, 1)}s)`);
    console.log('  Start/end errors below these are labelling noise, not real differences.');
    for (const x of lc.issues) console.log(`  ! ${x}`);
  } else {
    console.log('\nNo cases/relabel.json yet: relabel ~10 queries without looking, to measure your own labelling noise.');
  }
  return !broken.length;
}



async function runSearchCases(cases, videos, call, judge) {
  const rows = [];
  for (const c of cases) {
    if (process.stdout.isTTY) process.stdout.write(`\r${rows.length + 1}/${cases.length} ${c.id}`.padEnd(60));
    try {
      const v = videos[c.video];
      const r = await search(v, c.query, { hideChapters: c.hideChapters, call });
      const row = { id: c.id, source: c.source, query: c.query, score: scoreCase(c, { ...r, chunks: v.chunks }) };
      if (judge) {
        try {
          row.judge = await judgeCase({ judge, query: r.query, video: v, peaks: row.score.peaks, jumpTime: r.jumpTime });
        } catch (e) {
          row.judgeError = e.message;
        }
      }
      rows.push(row);
    } catch (e) {
      rows.push({ id: c.id, source: c.source, query: c.query, error: e.message });
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(61) + '\r');
  return rows;
}

const MIME = { '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };

// script.json: [{ id, text, keyTerms?: [...], case?: "<labelled query>" }]; recordings <id>.<ext>;
// instant.json: the popup's voice-log export from reading the script in order with Instant on.
async function runVoice({ cache, call, cases, videos }) {
  const scriptFile = join(DIR.voice, 'script.json');
  if (!existsSync(scriptFile)) {
    console.log('\nvoice: no eval/data/voice/script.json yet, skipped');
    return null;
  }
  const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
  const instantFile = join(DIR.voice, 'instant.json');
  const instant = existsSync(instantFile)
    ? JSON.parse(readFileSync(instantFile, 'utf8')).filter((e) => e.engine === 'chrome').map((e) => e.text)
    : null;
  const files = existsSync(DIR.voice) ? readdirSync(DIR.voice) : [];
  const openaiKey = process.env.OPENAI_API_KEY;

  const rows = [];
  for (const [i, line] of script.entries()) {
    const heard = {};
    if (instant) heard.instant = instant[i] ?? null;
    const rec = files.find((fn) => fn.startsWith(`${line.id}.`) && MIME[extname(fn)]);
    if (rec) {
      const bytes = readFileSync(join(DIR.voice, rec));
      try {
        heard.accurate = await cache.cached(`openai|${CONFIG.openai.model}|${createHash('sha256').update(bytes).digest('hex')}`, () => {
          if (!openaiKey) throw new Error('OPENAI_API_KEY is not set');
          return callTranscribe({ base64: bytes.toString('base64'), mimeType: MIME[extname(rec)], apiKey: openaiKey, config: CONFIG.openai });
        });
      } catch (e) {
        heard.accurate = { error: e.message };
      }
    }
    const c = line.case ? cases.find((x) => x.source === 'labelled' && x.query === line.case) : null;
    let typed = null;
    if (c) {
      try {
        typed = await search(videos[c.video], line.text, { hideChapters: false, call });
      } catch (e) {
        typed = { error: e.message };
      }
    }
    const row = { id: line.id, text: line.text, engines: {} };
    for (const [engine, text] of Object.entries(heard)) {
      if (text == null || text.error) {
        row.engines[engine] = { error: text?.error ?? 'no result in instant.json' };
        continue;
      }
      const e = { text, wer: wer(line.text, text), keyTerms: keyTermsKept(text, line.keyTerms) };
      if (c && typed && !typed.error) {
        try {
          const r = await search(videos[c.video], text, { hideChapters: false, call });
          e.landsSame = r.jumpTime != null && typed.jumpTime != null ? Math.abs(r.jumpTime - typed.jumpTime) <= 15 : r.jumpTime === typed.jumpTime;
          e.jumpOk = c.absent ? r.decision.kind === 'absent' : jumpOk(r.jumpTime, c.spots[0]);
        } catch (err) {
          e.searchError = err.message;
        }
      }
      row.engines[engine] = e;
    }
    rows.push(row);
  }

  console.log(`\nvoice (${rows.length} lines)`);
  for (const r of rows) {
    console.log(`  ${pad(r.id, 14)} "${r.text}"`);
    for (const [engine, e] of Object.entries(r.engines)) {
      if (e.error) {
        console.log(`    ${pad(engine, 9)} ERROR ${e.error}`);
        continue;
      }
      const land = e.landsSame == null ? '' : `  ${e.landsSame ? 'same spot' : 'DIFFERENT spot'}${e.jumpOk == null ? '' : e.jumpOk ? ' ✓' : ' ✗'}`;
      console.log(`    ${pad(engine, 9)} wer ${pct(e.wer)}  terms ${pct(e.keyTerms)}${land}  "${e.text}"`);
    }
  }
  const summary = {};
  for (const engine of ['instant', 'accurate']) {
    const es = rows.map((r) => r.engines[engine]).filter((e) => e && !e.error);
    if (!es.length) continue;
    const avg = (k) => {
      const xs = es.map((e) => e[k]).filter((v) => v != null).map(Number);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    summary[engine] = { lines: es.length, wer: avg('wer'), keyTerms: avg('keyTerms'), landsSame: avg('landsSame'), jumpOk: avg('jumpOk') };
    const s = summary[engine];
    console.log(`  ${pad(engine, 9)} mean wer ${pct(s.wer)}, key terms ${pct(s.keyTerms)}, same spot as typed ${pct(s.landsSame)}, jump acc ${pct(s.jumpOk)}`);
  }
  return { rows, summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sets = applySets(args.set);
  const all = loadVideos(DIR.videos);
  const videos = Object.fromEntries(Object.entries(all).map(([id, v]) => [id, prepareVideo(v, CONFIG)]));
  if (!Object.keys(videos).length) {
    console.log('No videos in eval/data/videos/. Export some from the extension popup (Dev · evals) first.');
    return;
  }
  let cases = [
    ...Object.values(videos).flatMap(chapterCases), ...loadLabelled(DIR.labelled, videos), ...loadQueries(DIR.queries, videos),
  ];
  if (args.video) cases = cases.filter((c) => c.video === args.video);
  if (args.case) cases = cases.filter((c) => c.id.includes(args.case) || c.query.toLowerCase().includes(args.case.toLowerCase()));
  if (args.check) {
    if (!runChecks(cases, videos)) process.exitCode = 1;
    return;
  }
  if (!args.offline && !process.env.JEV_API_KEY) console.warn('JEV_API_KEY is not set: only cached responses will work.');
  for (const [k, v] of Object.entries(sets)) console.log(`--set ${k}: ${v.from} → ${v.to}`);
  const allCases = cases; // voice lines look up their labelled case in every split
  const hidden = cases.length - splitCases(cases, args.split).length;
  cases = splitCases(cases, args.split);
  if (args.split !== 'all') {
    console.log(args.split === 'tune'
      ? `split: tune set (${hidden} held-back case(s) hidden; check them once at the end with --split holdout)`
      : `split: HOLDOUT (${cases.length} cases). Don't tune on these numbers.`);
  }

  const cache = makeCache(args);
  const call = (misses) => makeJevCall(cache, misses);
  const judgeModel = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const judge = args.judge
    ? makeJudge({ apiKey: process.env.OPENAI_API_KEY, model: judgeModel, endpoint: process.env.JUDGE_ENDPOINT || JUDGE_ENDPOINT, cached: cache.cached })
    : null;
  if (judge) console.log(`judge: ${judgeModel}`);
  const searchCases = args.only === 'voice' ? [] : cases.filter((c) => (args.only ? c.source === args.only : c.source !== 'queries' || args.judge));
  const rows = await runSearchCases(searchCases, videos, call, judge);
  const labelledOk = (s) => s.spots || s.absentOk != null;
  const allOf = (rs) => aggregate(rs.filter((r) => !r.error).map((r) => r.score).filter(labelledOk));
  const repeats = [allOf(rows)];
  for (let i = 1; i < args.repeat; i++) {
    console.log(`repeat ${i + 1}/${args.repeat}…`);
    repeats.push(allOf(await runSearchCases(searchCases, videos, (misses) => makeJevCall(cache, misses, i), null)));
  }

  const ok = (src) => rows.filter((r) => !r.error && (!src || r.source === src)).map((r) => r.score);
  const agg = {
    chapters: aggregate(ok('chapters')), labelled: aggregate(ok('labelled')), all: aggregate(ok().filter(labelledOk)),
  };
  const judgedRows = (src) => rows.filter((r) => r.judge && (!src || r.source === src));
  const judgeAgg = judge ? {
    chapters: judgeAggregate(judgedRows('chapters').map((r) => r.judge)),
    labelled: judgeAggregate(judgedRows('labelled').map((r) => r.judge)),
    queries: judgeAggregate(judgedRows('queries').map((r) => r.judge)),
    all: judgeAggregate(judgedRows().map((r) => r.judge)),
    agreement: agreement(judgedRows('labelled').map((r) => ({ c: cases.find((c) => c.id === r.id), score: r.score, judged: r.judge }))),
  } : null;
  const ci = {
    chapters: bootstrap(ok('chapters')), labelled: bootstrap(ok('labelled')), all: bootstrap(ok().filter(labelledOk)),
  };
  const disagree = judge
    ? disagreements(judgedRows('labelled').map((r) => ({ id: r.id, c: cases.find((c) => c.id === r.id), score: r.score, judged: r.judge })))
    : [];
  const prevRun = args.compare ? JSON.parse(readFileSync(args.compare, 'utf8')) : null;
  const prev = prevRun?.aggregate;

  if (rows.length) printCases(rows);
  printAggregate('chapters', agg.chapters, prev?.chapters, ci.chapters);
  printAggregate('labelled', agg.labelled, prev?.labelled, ci.labelled);
  printAggregate('all', agg.all, prev?.all, ci.all);
  if (agg.all.cases) console.log('\n[ranges] are 95% ranges over the cases: a change inside them may be luck.');
  const spread = args.repeat > 1 ? noise(repeats) : null;
  if (spread) {
    console.log(`\nrun-to-run noise over ${args.repeat} fresh runs (all cases): a change smaller than this is noise`);
    for (const [k, v] of Object.entries(spread)) {
      const fmt = /Err/.test(k) ? (x) => (x == null ? '–' : `${f(x, 1)}s`) : k === 'falsePeaks' ? (x) => f(x, 2) : pct;
      console.log(`  ${pad(k, 15)} ${fmt(v.min)} – ${fmt(v.max)}  (spread ${fmt(v.spread)})`);
    }
  }
  if (judgeAgg) {
    printJudge(rows);
    for (const k of ['chapters', 'labelled', 'queries', 'all']) printJudgeAggregate(k, judgeAgg[k], prevRun?.judge?.[k]);
    printAgreement(judgeAgg.agreement);
    printDisagreements(disagree);
  }
  const errored = rows.filter((r) => r.error).length;
  if (errored) console.log(`\n${errored} case(s) errored and are left out of the numbers.`);
  const voice = !args.only || args.only === 'voice' ? await runVoice({ cache, call, cases: allCases, videos }) : null;
  console.log(`\nJev/OpenAI: ${cache.stats.calls} calls, ${cache.stats.hits} cached${cache.stats.misses ? `, ${cache.stats.misses} missing (--offline)` : ''}`);

  mkdirSync(DIR.results, { recursive: true });
  let commit = null;
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const at = new Date().toISOString();
  const out = join(DIR.results, `${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify({ at, commit, args, config: CONFIG, sets, aggregate: agg, ranges: ci, noise: spread, judge: judgeAgg, disagreements: disagree, judgeModel: judge ? judgeModel : null, cases: rows, voice }, null, 1));
  console.log(`Saved ${out.slice(ROOT.length - 'eval/'.length)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
