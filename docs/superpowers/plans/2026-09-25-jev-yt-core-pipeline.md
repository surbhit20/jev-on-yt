# Jev YT Core Pipeline Implementation Plan (Phases 0–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loadable Chrome extension that extracts the transcript of any YouTube video, scores it with Jev for a typed query, and from the DevTools console jumps to the right spot or reports highlight/absent. There is no on-page UI yet.

**Architecture:** A MAIN-world bridge reads YouTube page internals and calls the transcript endpoint. The content script (isolated world) loads pure ES modules via dynamic `import(chrome.runtime.getURL(...))`, chunks the transcript and runs the decision logic. The background service worker (ES module) holds the API key, fans requests out to TypeSafe and caches results. All logic without DOM or Chrome dependencies lives in pure modules tested with `node --test`.

**Tech Stack:** Chrome Manifest V3, plain JavaScript ES modules, no build step, Node 20 built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-yt-design.md`

**Scope:** Spec build phases 0, 1 and 2. The UI (heatmap, toast, keys, voice), polish and eval come in a second plan written after this one's manual gates, because transcript and API behaviour found here may change it.

## Global Constraints

- Host permissions only `https://www.youtube.com/*` and `https://api.typesafe.ai/*`; permission `storage` only. No remote code.
- API key in `chrome.storage.local` under `apiKey`; never logged; sent only to `https://api.typesafe.ai/v1/systemone`.
- Model `jev-latest`. Question ids are deterministic: `rel_C014`, `start_C014`, `best`, `exists`, `line`.
- Every threshold/tunable lives in `src/config.js`; no literals elsewhere.
- Pure modules (`config`, `time`, `transcript_parse`, `chunker`, `query`, `request_builder`, `jev_client`, `pipeline`, `scoring`) import no DOM or `chrome.*` APIs.
- Retry only 429/529: base 500 ms, doubling, max 4 tries. Concurrency cap 10.
- Test files are `test/*.test.js`; fixtures are `.json` in `test/fixtures/`. Run all tests with `npm test` (`node --test`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Responsibility |
|---|---|
| `package.json` | `type: module`, `npm test` |
| `manifest.json` | MV3 manifest |
| `src/config.js` | All tunables |
| `src/time.js` | `formatTime`, `parseTimestamp` |
| `src/transcript_parse.js` | Pure parsing of YouTube JSON: transcript params, segments, chapters, panel rows |
| `src/page_bridge.js` | MAIN world (classic script): player data, transcript endpoint call |
| `src/bridge_client.js` | Isolated side of the bridge: `makeBridge().call(type, payload)` |
| `src/transcript.js` | `getTranscript()`: API method, then panel scrape (DOM) |
| `src/chunker.js` | Chunks, windows, window state text |
| `src/query.js` | `parseQuery()` |
| `src/request_builder.js` | Jev request bodies and answer readers |
| `src/jev_client.js` | `callJev()` with retry, `mapLimit()`, `JevError` |
| `src/pipeline.js` | `runQuery`, `runStart`, `runRefine` over an injected `call` |
| `src/scoring.js` | Merge, smooth, segments, walk-back, `decide()` |
| `src/background.js` | Service worker message handlers and cache |
| `src/content.js` | Classic content script: per-video prep and `jev.ask()` console API |
| `options/options.html`, `options/options.js` | Key entry and Test key |

---

### Task 1: Scaffold, config and time helpers

**Files:**
- Create: `package.json`, `src/config.js`, `src/time.js`
- Test: `test/config.test.js`, `test/time.test.js`

**Interfaces:**
- Produces: `CONFIG` (object below); `formatTime(sec: number): string`; `parseTimestamp(ts: string): number | null`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jev-yt",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';

test('thresholds are ordered sensibly', () => {
  assert.ok(CONFIG.absentT < CONFIG.foundT);
  assert.ok(CONFIG.windowOverlap < CONFIG.windowSize);
  assert.ok(CONFIG.margin >= 1);
});

test('chunk rules ascend and end with Infinity', () => {
  const r = CONFIG.chunkRules;
  for (let i = 1; i < r.length; i++) assert.ok(r[i].maxDurationSec > r[i - 1].maxDurationSec);
  assert.equal(r.at(-1).maxDurationSec, Infinity);
});

test('smoothing kernel sums to 1', () => {
  assert.equal(CONFIG.kernel.reduce((a, b) => a + b, 0), 1);
});
```

`test/time.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, parseTimestamp } from '../src/time.js';

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(6129), '1:42:09');
  assert.equal(formatTime(-5), '0:00');
});

test('parseTimestamp', () => {
  assert.equal(parseTimestamp('1:42:09'), 6129);
  assert.equal(parseTimestamp('0:05'), 5);
  assert.equal(parseTimestamp(' 3:07 '), 187);
  assert.equal(parseTimestamp('12'), 12);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(''), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/config.js'`.

- [ ] **Step 4: Implement**

`src/config.js`:

```js
// Every tunable lives here. Nothing else hardcodes thresholds.
export const CONFIG = {
  model: 'jev-latest',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  dev: true,

  // Chunking
  chunkRules: [
    { maxDurationSec: 20 * 60, chunkSec: 15 },
    { maxDurationSec: 2 * 60 * 60, chunkSec: 30 },
    { maxDurationSec: Infinity, chunkSec: 45 },
  ],
  sentenceSlack: 0.4,
  windowSize: 30,
  windowOverlap: 1,

  // Requests
  concurrency: 10,
  retryTries: 4,
  retryBaseMs: 500,
  maxRefineLines: 255,

  // Scoring
  kernel: [0.25, 0.5, 0.25],
  relT: 0.5,
  gapChunks: 1,
  bestBoost: 1.2,
  absentT: 0.35,
  foundT: 0.7,
  margin: 1.5,
  walkBackChunks: 3,
  startT: 0.5,
  chapterStart: 1,
  chapterOther: 0.3,
  seekPadSec: 3,
  refinePadSec: 1.5,

  // UI
  revealMs: 5000,
};
```

`src/time.js`:

```js
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function parseTimestamp(ts) {
  const parts = String(ts).trim().split(':');
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.js src/time.js test/config.test.js test/time.test.js
git commit -m "Add config and time helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Transcript parsing (pure)

**Files:**
- Create: `src/transcript_parse.js`
- Test: `test/transcript_parse.test.js`, `test/fixtures/get_transcript_response.json`, `test/fixtures/watch_data.json`

**Interfaces:**
- Consumes: `parseTimestamp` from `src/time.js`
- Produces:
  - `findAll(root: any, key: string): any[]` (document-order DFS)
  - `findTranscriptParams(data): string | null`
  - `parseTranscriptResponse(json): Line[]` where `Line = { start: number, end: number, text: string }` (seconds)
  - `parseChapters(data): { title: string, start: number }[]`
  - `linesFromPanel(rows: { ts: string, text: string }[], durationSec: number): Line[]`

- [ ] **Step 1: Write the fixtures**

`test/fixtures/get_transcript_response.json` (the shape of YouTube's `get_transcript` response, trimmed):

```json
{"actions":[{"updateEngagementPanelAction":{"content":{"transcriptRenderer":{"content":{"transcriptSearchPanelRenderer":{"body":{"transcriptSegmentListRenderer":{"initialSegments":[
  {"transcriptSectionHeaderRenderer":{"startMs":"0","endMs":"60000","snippet":{"simpleText":"Intro"}}},
  {"transcriptSegmentRenderer":{"startMs":"0","endMs":"4200","snippet":{"runs":[{"text":"Welcome to the\nshow."}]}}},
  {"transcriptSegmentRenderer":{"startMs":"4200","endMs":"9000","snippet":{"runs":[{"text":"Today we talk "},{"text":"about sleep."}]}}},
  {"transcriptSegmentRenderer":{"startMs":"9000","endMs":"9000","snippet":{"runs":[{"text":"[Music]"}]}}},
  {"transcriptSegmentRenderer":{"startMs":"12000","endMs":"15000","snippet":{"runs":[{"text":"  "}]}}}
]}}}}}}}}]}
```

`test/fixtures/watch_data.json` (the shape of the watch page's `ytInitialData`, trimmed):

```json
{
  "currentVideoEndpoint": {"watchEndpoint": {"videoId": "abc123"}},
  "engagementPanels": [{"engagementPanelSectionListRenderer": {
    "targetId": "engagement-panel-searchable-transcript",
    "content": {"continuationItemRenderer": {"continuationEndpoint": {"getTranscriptEndpoint": {"params": "CgtQQVJBTVM="}}}}
  }}],
  "playerOverlays": {"playerOverlayRenderer": {"decoratedPlayerBarRenderer": {"decoratedPlayerBarRenderer": {"playerBar": {"multiMarkersPlayerBarRenderer": {"markersMap": [
    {"key": "DESCRIPTION_CHAPTERS", "value": {"chapters": [
      {"chapterRenderer": {"title": {"simpleText": "Intro"}, "timeRangeStartMillis": 0}},
      {"chapterRenderer": {"title": {"simpleText": "Caffeine"}, "timeRangeStartMillis": 754000}},
      {"chapterRenderer": {"title": {"simpleText": "Sleep"}, "timeRangeStartMillis": 2410000}}
    ]}}
  ]}}}}}}
}
```

- [ ] **Step 2: Write the failing tests**

`test/transcript_parse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findAll, findTranscriptParams, parseTranscriptResponse, parseChapters, linesFromPanel,
} from '../src/transcript_parse.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('findAll returns values in document order', () => {
  const data = { a: { k: 1 }, b: [{ k: 2 }, { c: { k: 3 } }] };
  assert.deepEqual(findAll(data, 'k'), [1, 2, 3]);
});

test('findTranscriptParams', () => {
  assert.equal(findTranscriptParams(fixture('watch_data.json')), 'CgtQQVJBTVM=');
  assert.equal(findTranscriptParams({}), null);
});

test('parseTranscriptResponse: text, seconds, cleanup, ends', () => {
  const lines = parseTranscriptResponse(fixture('get_transcript_response.json'));
  assert.deepEqual(lines, [
    { start: 0, end: 4.2, text: 'Welcome to the show.' },
    { start: 4.2, end: 9, text: 'Today we talk about sleep.' },
    { start: 9, end: 11, text: '[Music]' },
  ]);
});

test('parseTranscriptResponse: zero-length line ends at next start', () => {
  const json = { initialSegments: [
    { transcriptSegmentRenderer: { startMs: '1000', endMs: '1000', snippet: { runs: [{ text: 'a' }] } } },
    { transcriptSegmentRenderer: { startMs: '1500', endMs: '3000', snippet: { runs: [{ text: 'b' }] } } },
  ] };
  assert.deepEqual(parseTranscriptResponse(json).map((l) => l.end), [1.5, 3]);
});

test('parseChapters: sorted, deduped', () => {
  const data = fixture('watch_data.json');
  const dup = { x: data, y: { chapterRenderer: { title: { simpleText: 'Intro' }, timeRangeStartMillis: 0 } } };
  const expected = [
    { title: 'Intro', start: 0 },
    { title: 'Caffeine', start: 754 },
    { title: 'Sleep', start: 2410 },
  ];
  assert.deepEqual(parseChapters(data), expected);
  assert.deepEqual(parseChapters(dup), expected);
  assert.deepEqual(parseChapters({}), []);
});

test('linesFromPanel: drops bad rows, ends at next start or duration', () => {
  const rows = [
    { ts: '0:00', text: ' Hi ' },
    { ts: 'bad', text: 'x' },
    { ts: '0:04', text: 'there' },
    { ts: '0:09', text: '' },
  ];
  assert.deepEqual(linesFromPanel(rows, 20), [
    { start: 0, end: 4, text: 'Hi' },
    { start: 4, end: 20, text: 'there' },
  ]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/transcript_parse.js'`.

- [ ] **Step 4: Implement `src/transcript_parse.js`**

```js
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
```

Note for `linesFromPanel`: with `fillEnds(lines, durationSec)` the last line ends at `durationSec`, and each other line ends at the next start.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all tests, including Task 1's).

- [ ] **Step 6: Commit**

```bash
git add src/transcript_parse.js test/transcript_parse.test.js test/fixtures
git commit -m "Add pure transcript and chapter parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Phase 0, transcript extraction in the real extension

**Files:**
- Create: `manifest.json`, `src/page_bridge.js`, `src/bridge_client.js`, `src/transcript.js`, `src/content.js`

**Interfaces:**
- Consumes: `findTranscriptParams`, `parseTranscriptResponse`, `parseChapters`, `linesFromPanel` (Task 2); `formatTime` (Task 1)
- Produces:
  - Bridge message protocol: request `{ source: 'jev-yt:req', id, type, payload }`, response `{ source: 'jev-yt:res', id, result, error }`
  - Bridge types: `videoInfo({ videoId }) → { ready: false } | { ready: true, duration, title, dataJson }`; `fetchTranscript({ params }) → { status, body }`
  - `makeBridge(timeoutMs?) → { call(type, payload): Promise<result> }`
  - `getTranscript({ bridge, data, durationSec, log }) → Promise<{ lines: Line[], method: 'api' | 'panel' } | null>`
  - Content-script global (isolated world) `globalThis.jev.video` with `{ id, gen, status, lines, chapters, durationSec }`

This task is DOM glue verified manually; there are no unit tests. Its output decides the primary/fallback order.

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Jev YT",
  "version": "0.1.0",
  "description": "Ask a YouTube video a question and jump to the answer.",
  "permissions": ["storage"],
  "host_permissions": ["https://www.youtube.com/*", "https://api.typesafe.ai/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://www.youtube.com/*"], "js": ["src/page_bridge.js"], "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://www.youtube.com/*"], "js": ["src/content.js"], "run_at": "document_idle" }
  ],
  "web_accessible_resources": [
    { "resources": ["src/*.js"], "matches": ["https://www.youtube.com/*"] }
  ],
  "options_page": "options/options.html"
}
```

Create a placeholder `src/background.js` containing `// Filled in by Task 9.` so the extension loads.

- [ ] **Step 2: Write `src/page_bridge.js`** (classic script, runs in YouTube's page world)

```js
// Runs in the page's MAIN world. The only code that touches YouTube internals.
(() => {
  const REQ = 'jev-yt:req';
  const RES = 'jev-yt:res';

  const player = () => document.getElementById('movie_player');

  function candidates() {
    const out = [];
    try {
      const d = document.querySelector('ytd-page-manager')?.getCurrentData?.();
      if (d?.response) out.push(d.response);
    } catch {}
    try {
      const d = document.querySelector('ytd-watch-flexy')?.data;
      if (d) out.push(d);
    } catch {}
    if (window.ytInitialData) out.push(window.ytInitialData);
    return out;
  }

  function watchData(videoId) {
    return candidates().find((d) => d?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId) ?? null;
  }

  const handlers = {
    videoInfo({ videoId }) {
      const p = player();
      const vd = p?.getVideoData?.();
      if (!vd || vd.video_id !== videoId) return { ready: false };
      const data = watchData(videoId);
      if (!data) return { ready: false };
      return { ready: true, duration: p.getDuration?.() ?? 0, title: vd.title ?? '', dataJson: JSON.stringify(data) };
    },
    async fetchTranscript({ params }) {
      const cfg = window.ytcfg;
      const res = await fetch('/youtubei/v1/get_transcript?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': String(cfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
          'X-Youtube-Client-Version': String(cfg?.get?.('INNERTUBE_CLIENT_VERSION') ?? ''),
        },
        body: JSON.stringify({ context: cfg?.get?.('INNERTUBE_CONTEXT'), params }),
      });
      return { status: res.status, body: await res.text() };
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== REQ) return;
    const { id, type, payload } = e.data;
    const handler = handlers[type];
    let result;
    let error;
    try {
      if (!handler) throw new Error(`unknown type ${type}`);
      result = await handler(payload ?? {});
    } catch (err) {
      error = String(err?.message ?? err);
    }
    window.postMessage({ source: RES, id, result, error }, '*');
  });
})();
```

- [ ] **Step 3: Write `src/bridge_client.js`**

```js
export function makeBridge(timeoutMs = 10000) {
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'jev-yt:res') return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  });

  return {
    call(type, payload) {
      const id = `${Date.now()}-${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge timeout: ${type}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ source: 'jev-yt:req', id, type, payload }, '*');
      });
    },
  };
}
```

- [ ] **Step 4: Write `src/transcript.js`**

```js
import { findTranscriptParams, parseTranscriptResponse, linesFromPanel } from './transcript_parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

// The only transcript entry point. Other sites can add their own implementation later.
export async function getTranscript({ bridge, data, durationSec, log = () => {} }) {
  const params = findTranscriptParams(data);
  if (params) {
    try {
      const res = await bridge.call('fetchTranscript', { params });
      if (res.status === 200) {
        const lines = parseTranscriptResponse(JSON.parse(res.body));
        if (lines.length) return { lines, method: 'api' };
        log('transcript api returned 0 lines');
      } else {
        log(`transcript api status ${res.status}: ${res.body.slice(0, 200)}`);
      }
    } catch (e) {
      log(`transcript api failed: ${e.message}`);
    }
  } else {
    log('no transcript params in page data');
  }

  try {
    const lines = await scrapePanel(durationSec);
    if (lines.length) return { lines, method: 'panel' };
    log('transcript panel had 0 lines');
  } catch (e) {
    log(`transcript panel failed: ${e.message}`);
  }
  return null;
}

async function scrapePanel(durationSec) {
  const wasOpen = document.querySelector(PANEL)?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  if (!wasOpen) {
    const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) throw new Error('no "Show transcript" button');
    btn.click();
  }
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    await sleep(200);
    rows = [...document.querySelectorAll(`${PANEL} ytd-transcript-segment-renderer`)].map((s) => ({
      ts: s.querySelector('.segment-timestamp')?.textContent ?? '',
      text: s.querySelector('.segment-text')?.textContent ?? '',
    }));
  }
  if (!wasOpen) document.querySelector(PANEL)?.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  return linesFromPanel(rows, durationSec);
}
```

- [ ] **Step 5: Write `src/content.js` (Phase 0 version)** (classic script; loads modules dynamically)

```js
(async () => {
  const load = (p) => import(chrome.runtime.getURL(p));
  const [{ makeBridge }, { getTranscript }, { parseChapters }, { formatTime }] = await Promise.all([
    load('src/bridge_client.js'),
    load('src/transcript.js'),
    load('src/transcript_parse.js'),
    load('src/time.js'),
  ]);

  const log = (...a) => console.log('[jev-yt]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = makeBridge();
  const video = { id: null, gen: 0, status: 'idle' };

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  async function waitForInfo(videoId, gen) {
    for (let i = 0; i < 30; i++) {
      if (gen !== video.gen) return null;
      const info = await bridge.call('videoInfo', { videoId }).catch(() => null);
      if (info?.ready) return info;
      await sleep(500);
    }
    return null;
  }

  async function prepare() {
    const videoId = currentVideoId();
    if (videoId === video.id) return;
    const gen = ++video.gen;
    Object.assign(video, { id: videoId, status: videoId ? 'preparing' : 'idle', lines: null, chapters: [], durationSec: 0 });
    if (!videoId) return;

    const t0 = performance.now();
    const info = await waitForInfo(videoId, gen);
    if (gen !== video.gen) return;
    if (!info) {
      video.status = 'unavailable';
      return log('no player data for', videoId);
    }
    const data = JSON.parse(info.dataJson);
    const chapters = parseChapters(data);
    const result = await getTranscript({ bridge, data, durationSec: info.duration, log });
    if (gen !== video.gen) return;
    if (!result) {
      video.status = 'unavailable';
      return log('No transcript for this video');
    }
    Object.assign(video, { status: 'ready', lines: result.lines, chapters, durationSec: info.duration });

    const fmt = (l) => `${formatTime(l.start)}–${formatTime(l.end)}  ${l.text}`;
    log(`${videoId} "${info.title}" via ${result.method}: ${result.lines.length} lines, ` +
      `${chapters.length} chapters, ${Math.round(performance.now() - t0)} ms`);
    log('first 5:\n' + result.lines.slice(0, 5).map(fmt).join('\n'));
    log('last 5:\n' + result.lines.slice(-5).map(fmt).join('\n'));
    if (chapters.length) log('chapters:\n' + chapters.map((c) => `${formatTime(c.start)} ${c.title}`).join('\n'));
  }

  globalThis.jev = { video };
  document.addEventListener('yt-navigate-finish', prepare);
  prepare();
})();
```

- [ ] **Step 6: Optional pre-check without the extension**

In the built-in browser, open any YouTube watch page and run the body of `handlers.videoInfo`, then `fetchTranscript` using `window.ytcfg` (javascript tool, page context). Confirm a `200` with `transcriptSegmentRenderer` entries. If you get `400 FAILED_PRECONDITION`, record it: the panel fallback becomes primary.

- [ ] **Step 7: Manual gate (user)**

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `~/jev-yt`.
2. Open DevTools on YouTube and filter the console by `[jev-yt]`.
3. Check each and record the method and timing:
   - a 2 h podcast with chapters;
   - a video with only auto-generated captions;
   - a video with no captions (expect `No transcript for this video`);
   - navigate from one video to another via a recommendation, which must log the new video, not the old one.

Done when the 2 h podcast logs sensible first and last lines whose timestamps match the player.

- [ ] **Step 8: Commit**

```bash
git add manifest.json src/page_bridge.js src/bridge_client.js src/transcript.js src/content.js src/background.js
git commit -m "Phase 0: transcript extraction via MAIN-world bridge with panel fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Chunker

**Files:**
- Create: `src/chunker.js`
- Test: `test/chunker.test.js`

**Interfaces:**
- Consumes: `formatTime` (Task 1)
- Produces:
  - `Chunk = { id: string, start: number, end: number, text: string, lineIdx: [number, number] }`
  - `chunkSecondsFor(durationSec, rules): number`
  - `buildChunks(lines: Line[], targetSec: number, slack: number): Chunk[]`
  - `chunkId(i): string` (`'C007'`), `chunkIndex(id): number`
  - `buildWindows(chunks, size, overlap): Chunk[][]`
  - `windowState(chunks): string` (lines `C014 [12:30] text…`)

- [ ] **Step 1: Write the failing tests**

`test/chunker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkSecondsFor, buildChunks, chunkId, chunkIndex, buildWindows, windowState,
} from '../src/chunker.js';
import { CONFIG } from '../src/config.js';

const makeLines = (count, step = 4, text = (i) => `word${i}`) =>
  Array.from({ length: count }, (_, i) => ({ start: i * step, end: (i + 1) * step, text: text(i) }));

test('chunkSecondsFor uses duration rules', () => {
  assert.equal(chunkSecondsFor(600, CONFIG.chunkRules), 15);
  assert.equal(chunkSecondsFor(1200, CONFIG.chunkRules), 15);
  assert.equal(chunkSecondsFor(3600, CONFIG.chunkRules), 30);
  assert.equal(chunkSecondsFor(4 * 3600, CONFIG.chunkRules), 45);
});

test('chunkId / chunkIndex round trip', () => {
  assert.equal(chunkId(7), 'C007');
  assert.equal(chunkId(1234), 'C1234');
  assert.equal(chunkIndex('C014'), 14);
});

test('buildChunks: no punctuation closes at the upper bound', () => {
  const lines = makeLines(100);
  const chunks = buildChunks(lines, 30, 0.4);
  assert.deepEqual(chunks[0].lineIdx, [0, 10]); // 44 s >= 42 s
  for (const c of chunks.slice(0, -1)) assert.ok(c.end - c.start <= 42 + 4);
  // contiguous coverage of every line
  assert.equal(chunks[0].lineIdx[0], 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].lineIdx[0], chunks[i - 1].lineIdx[1] + 1);
  assert.equal(chunks.at(-1).lineIdx[1], 99);
  assert.deepEqual(chunks.map((c) => c.id).slice(0, 3), ['C000', 'C001', 'C002']);
  assert.equal(chunks.map((c) => c.text).join(' '), lines.map((l) => l.text).join(' '));
});

test('buildChunks: prefers a sentence end inside the slack band', () => {
  const lines = makeLines(40, 4, (i) => (i === 5 ? 'end of thought.' : `w${i}`));
  const chunks = buildChunks(lines, 30, 0.4);
  assert.deepEqual(chunks[0].lineIdx, [0, 5]); // 24 s >= 18 s and ends with "."
});

test('buildChunks: a tiny remainder merges into the previous chunk', () => {
  const lines = makeLines(12); // 11 lines close the first chunk, 1 line (4 s) remains
  const chunks = buildChunks(lines, 30, 0.4);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].lineIdx, [0, 11]);
  assert.equal(chunks[0].end, 48);
});

test('buildChunks: empty input', () => {
  assert.deepEqual(buildChunks([], 30, 0.4), []);
});

test('buildWindows: size and 1-chunk overlap', () => {
  const chunks = Array.from({ length: 65 }, (_, i) => ({ id: chunkId(i) }));
  const w = buildWindows(chunks, 30, 1);
  assert.deepEqual(w.map((x) => x.length), [30, 30, 7]);
  assert.equal(w[0].at(-1).id, w[1][0].id);
  assert.equal(w.at(-1).at(-1).id, 'C064');
  assert.equal(buildWindows(chunks.slice(0, 30), 30, 1).length, 1);
  assert.deepEqual(buildWindows(chunks.slice(0, 31), 30, 1).map((x) => x.length), [30, 2]);
  assert.deepEqual(buildWindows([], 30, 1), []);
});

test('windowState formats one line per chunk', () => {
  const s = windowState([
    { id: 'C000', start: 0, text: 'hello' },
    { id: 'C001', start: 750, text: 'world' },
  ]);
  assert.equal(s, 'C000 [0:00] hello\nC001 [12:30] world');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/chunker.js'`.

- [ ] **Step 3: Implement `src/chunker.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chunker.js test/chunker.test.js
git commit -m "Add adaptive chunker and windowing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Query parsing

**Files:**
- Create: `src/query.js`
- Test: `test/query.test.js`

**Interfaces:**
- Produces: `parseQuery(raw: string): { kind: 'empty' | 'next' | 'back' | 'search', query: string, highlightOnly: boolean }`

- [ ] **Step 1: Write the failing tests**

`test/query.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query.js';

const cases = [
  ['skip to where he talks about caffeine and sleep', 'search', 'caffeine and sleep', false],
  ['Where does she discuss dopamine?', 'search', 'dopamine', true],
  ['show me the part about creatine', 'search', 'creatine', true],
  ['take me to the bit where they discuss sleep', 'search', 'sleep', false],
  ['jump to the section on cold plunges', 'search', 'cold plunges', false],
  ['find morning sunlight', 'search', 'morning sunlight', true],
  ['caffeine', 'search', 'caffeine', false],
  ['itinerary planning', 'search', 'itinerary planning', false],
  ['health span', 'search', 'health span', false],
  ['Next.', 'next', '', false],
  ['GO BACK', 'back', '', false],
  ['previous', 'back', '', false],
  ['', 'empty', '', false],
  ['jump to', 'empty', '', false],
];

for (const [input, kind, query, highlightOnly] of cases) {
  test(`parseQuery(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseQuery(input), { kind, query, highlightOnly });
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/query.js'`.

- [ ] **Step 3: Implement `src/query.js`**

```js
const VERBS = [
  'talk', 'talks', 'talking', 'discuss', 'discusses', 'discussing', 'mention', 'mentions', 'mentioning',
  'speak', 'speaks', 'speaking', 'explain', 'explains', 'explaining', 'cover', 'covers', 'covering',
  'go over', 'goes over', 'get into', 'gets into', 'say', 'says',
].join('|');
const WHO = ['he', 'she', 'they', 'we', 'you', 'someone', 'somebody', 'the speaker', 'the host', 'the guest', 'it',
  "he's", "she's", "they're"].join('|');

// Applied in order, each at most once, to strip command phrasing.
const FILLERS = [
  /^(please|hey|ok|okay)\s+/,
  /^(can|could) you\s+/,
  /^(skip|jump|go|take me|fast forward|seek|move|bring me)(\s+(ahead|forward|back))?(\s+to)?\s+/,
  /^(show|highlight|find)(\s+me)?\s+/,
  /^(the\s+)?(part|bit|section|moment|spot|place|point)s?\s+(about|on|where|when)\s+/,
  new RegExp(`^(where|when)(\\s+(does|do|did|is|are|was))?(\\s+(${WHO}))?(\\s+(is|are|was))?(\\s+(${VERBS}))?(\\s+(about|on))?\\s+`),
  new RegExp(`^(${WHO})(\\s+(is|are|was))?\\s+(${VERBS})(\\s+(about|on))?\\s+`),
  /^(about|on|regarding)\s+/,
];

const NEXT = /^(next|next one|go next)$/;
const BACK = /^(back|go back|previous|prev|previous one|last one)$/;
const HIGHLIGHT_ONLY = /^(show|where|highlight|find)\b/;
// A command with nothing after it ("jump to", "show me") has no topic.
const BARE_COMMAND = /^((skip|jump|go|take me|fast forward|seek|move|bring me)(\s+(ahead|forward|back))?(\s+to)?|(show|highlight|find)(\s+me)?)$/;

export function parseQuery(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?.!,;:]+$/, '').trim();
  const none = { query: '', highlightOnly: false };
  if (!text || BARE_COMMAND.test(text)) return { kind: 'empty', ...none };
  if (NEXT.test(text)) return { kind: 'next', ...none };
  if (BACK.test(text)) return { kind: 'back', ...none };

  const highlightOnly = HIGHLIGHT_ONLY.test(text);
  let q = text;
  for (const re of FILLERS) q = q.replace(re, '');
  q = q.trim();
  if (!q) return { kind: 'empty', ...none };
  return { kind: 'search', query: q, highlightOnly };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If a case fails, fix the regex for that case only, and don't loosen the others.

- [ ] **Step 5: Commit**

```bash
git add src/query.js test/query.test.js
git commit -m "Add query parsing (next/back, highlight-only, filler stripping)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Request builder and answer readers

**Files:**
- Create: `src/request_builder.js`
- Test: `test/request_builder.test.js`

**Interfaces:**
- Consumes: `windowState` (Task 4), `formatTime` (Task 1)
- Produces:
  - `buildQueryRequest(win: Chunk[], query: string, model: string): Body`
  - `buildStartRequest(win: Chunk[], model: string): Body`
  - `lineId(i): string` (`'L0412'`)
  - `buildRefineRequest(lines: Line[], offset: number, query: string, model: string, maxLines: number): Body`
  - `buildTestRequest(model): Body`
  - `readQueryAnswers(win, resp) → { rel: {[chunkId]: number|null}, best: string|null, exists: number|null }`
  - `readStartAnswers(win, resp) → {[chunkId]: number|null}`
  - `readRefineAnswer(resp) → number|null` (absolute line index)
  - `Body = { model, state: string, questions: {[id]: Question} }`

- [ ] **Step 1: Write the failing tests**

`test/request_builder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryRequest, buildStartRequest, buildRefineRequest, buildTestRequest, lineId,
  readQueryAnswers, readStartAnswers, readRefineAnswer,
} from '../src/request_builder.js';

const win = [
  { id: 'C000', start: 0, text: 'intro' },
  { id: 'C001', start: 30, text: 'caffeine talk' },
];

test('buildQueryRequest', () => {
  const b = buildQueryRequest(win, 'caffeine', 'jev-latest');
  assert.equal(b.model, 'jev-latest');
  assert.equal(b.state, 'C000 [0:00] intro\nC001 [0:30] caffeine talk');
  assert.deepEqual(Object.keys(b.questions), ['rel_C000', 'rel_C001', 'best', 'exists']);
  assert.equal(b.questions.rel_C001.type, 'noul');
  assert.match(b.questions.rel_C001.instructions, /chunk C001 .*"caffeine"/);
  assert.deepEqual(Object.keys(b.questions.rel_C001.criteria), ['true', 'false']);
  assert.equal(b.questions.best.type, 'choice');
  assert.deepEqual(b.questions.best.criteria, { C000: null, C001: null });
  assert.equal(b.questions.exists.type, 'noul');
});

test('query text is safely quoted', () => {
  const b = buildQueryRequest(win, 'say "hi"', 'm');
  assert.ok(b.questions.best.instructions.includes('"say \\"hi\\""'));
});

test('buildStartRequest', () => {
  const b = buildStartRequest(win, 'm');
  assert.deepEqual(Object.keys(b.questions), ['start_C000', 'start_C001']);
  assert.equal(b.questions.start_C000.type, 'noul');
});

test('buildRefineRequest uses absolute line ids and caps lines', () => {
  const lines = [{ start: 6118, text: 'so caffeine' }, { start: 6121, text: 'blocks adenosine' }, { start: 6125, text: 'x' }];
  const b = buildRefineRequest(lines, 410, 'caffeine', 'm', 2);
  assert.equal(lineId(412), 'L0412');
  assert.deepEqual(b.questions.line.criteria, { L0410: null, L0411: null });
  assert.equal(b.state, 'L0410 [1:41:58] so caffeine\nL0411 [1:42:01] blocks adenosine');
});

test('buildTestRequest has one noul', () => {
  const b = buildTestRequest('m');
  assert.equal(Object.values(b.questions).length, 1);
  assert.equal(Object.values(b.questions)[0].type, 'noul');
});

test('readQueryAnswers handles wrapped and bare shapes and missing values', () => {
  const answers = {
    rel_C000: { noul: 0.9 },
    best: { choice: 'C001', probabilities: { C000: 0.2, C001: 0.8 }, confidence: 0.8 },
    exists: { noul: 0.7 },
  };
  const expected = { rel: { C000: 0.9, C001: null }, best: 'C001', exists: 0.7 };
  assert.deepEqual(readQueryAnswers(win, { answers }), expected);
  assert.deepEqual(readQueryAnswers(win, answers), expected);
  assert.deepEqual(readQueryAnswers(win, {}), { rel: { C000: null, C001: null }, best: null, exists: null });
});

test('readStartAnswers', () => {
  assert.deepEqual(readStartAnswers(win, { answers: { start_C000: { noul: 0.6 } } }), { C000: 0.6, C001: null });
});

test('readRefineAnswer', () => {
  assert.equal(readRefineAnswer({ answers: { line: { choice: 'L0412' } } }), 412);
  assert.equal(readRefineAnswer({}), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/request_builder.js'`.

- [ ] **Step 3: Implement `src/request_builder.js`**

```js
import { windowState } from './chunker.js';
import { formatTime } from './time.js';

const quote = (s) => JSON.stringify(String(s));

export function buildQueryRequest(win, query, model) {
  const q = quote(query);
  const questions = {};
  for (const c of win) {
    questions[`rel_${c.id}`] = {
      type: 'noul',
      instructions: `Does chunk ${c.id} discuss or answer: ${q}?`,
      criteria: {
        true: 'This chunk substantively discusses the topic',
        false: 'The topic is absent or only mentioned in passing',
      },
    };
  }
  questions.best = {
    type: 'choice',
    instructions: `Which chunk best answers: ${q}?`,
    criteria: Object.fromEntries(win.map((c) => [c.id, null])),
  };
  questions.exists = {
    type: 'noul',
    instructions: `Does any chunk in this window substantively discuss: ${q}?`,
    criteria: {
      true: 'At least one chunk substantively discusses the topic',
      false: 'No chunk substantively discusses the topic',
    },
  };
  return { model, state: windowState(win), questions };
}

export function buildStartRequest(win, model) {
  const questions = {};
  for (const c of win) {
    questions[`start_${c.id}`] = {
      type: 'noul',
      instructions: `Does chunk ${c.id} begin a new topic or discussion, rather than continue the previous one?`,
      criteria: {
        true: 'This chunk starts a new topic or discussion',
        false: 'This chunk continues the previous topic',
      },
    };
  }
  return { model, state: windowState(win), questions };
}

export const lineId = (i) => 'L' + String(i).padStart(4, '0');

export function buildRefineRequest(lines, offset, query, model, maxLines) {
  const slice = lines.slice(0, maxLines);
  const ids = slice.map((_, i) => lineId(offset + i));
  return {
    model,
    state: slice.map((l, i) => `${ids[i]} [${formatTime(l.start)}] ${l.text}`).join('\n'),
    questions: {
      line: {
        type: 'choice',
        instructions: `Which line begins the discussion of: ${quote(query)}?`,
        criteria: Object.fromEntries(ids.map((id) => [id, null])),
      },
    },
  };
}

export function buildTestRequest(model) {
  return {
    model,
    state: 'The sky is blue today.',
    questions: {
      test: {
        type: 'noul',
        instructions: 'Is the sky described as blue?',
        criteria: { true: 'The sky is described as blue', false: 'It is not' },
      },
    },
  };
}

const answersOf = (resp) => resp?.answers ?? resp ?? {};
const num = (v) => (typeof v === 'number' ? v : null);

export function readQueryAnswers(win, resp) {
  const a = answersOf(resp);
  const rel = {};
  for (const c of win) rel[c.id] = num(a[`rel_${c.id}`]?.noul);
  return {
    rel,
    best: typeof a.best?.choice === 'string' ? a.best.choice : null,
    exists: num(a.exists?.noul),
  };
}

export function readStartAnswers(win, resp) {
  const a = answersOf(resp);
  return Object.fromEntries(win.map((c) => [c.id, num(a[`start_${c.id}`]?.noul)]));
}

export function readRefineAnswer(resp) {
  const choice = answersOf(resp).line?.choice;
  return typeof choice === 'string' && /^L\d+$/.test(choice) ? parseInt(choice.slice(1), 10) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/request_builder.js test/request_builder.test.js
git commit -m "Add Jev request builders and answer readers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Jev client with retry, and concurrency helper

**Files:**
- Create: `src/jev_client.js`
- Test: `test/jev_client.test.js`

**Interfaces:**
- Produces:
  - `class JevError extends Error { status: number | 'network' | 'nokey' }`
  - `callJev(body, { apiKey, endpoint, fetchImpl?, tries?, baseMs?, sleep? }) → Promise<{ data, ms, attempts }>`
  - `mapLimit(items, limit, fn(item, i)) → Promise<results[]>` (order preserved)

- [ ] **Step 1: Write the failing tests**

`test/jev_client.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callJev, JevError, mapLimit } from '../src/jev_client.js';

const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s === 'throw') throw new Error('offline');
    return response(s, { answers: { ok: true } });
  };
  fn.calls = calls;
  return fn;
}

const opts = (fetchImpl, delays = []) => ({
  apiKey: 'k', endpoint: 'https://x/v1', fetchImpl, tries: 4, baseMs: 500,
  sleep: async (ms) => { delays.push(ms); },
});

test('success sends auth and JSON body', async () => {
  const f = fakeFetch([200]);
  const r = await callJev({ a: 1 }, opts(f));
  assert.deepEqual(r.data, { answers: { ok: true } });
  assert.equal(r.attempts, 1);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(f.calls[0].init.body, '{"a":1}');
});

test('429 then 200 retries once with 500 ms', async () => {
  const delays = [];
  const r = await callJev({}, opts(fakeFetch([429, 200]), delays));
  assert.equal(r.attempts, 2);
  assert.deepEqual(delays, [500]);
});

test('529 four times gives up with doubling backoff', async () => {
  const delays = [];
  await assert.rejects(callJev({}, opts(fakeFetch([529]), delays)), (e) => e instanceof JevError && e.status === 529);
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test('401 fails immediately', async () => {
  const delays = [];
  const f = fakeFetch([401]);
  await assert.rejects(callJev({}, opts(f, delays)), (e) => e.status === 401);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(delays, []);
});

test('network error has status "network"', async () => {
  await assert.rejects(callJev({}, opts(fakeFetch(['throw']))), (e) => e.status === 'network');
});

test('mapLimit preserves order and respects the limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, x));
    active--;
    return x * 10 + i;
  });
  assert.deepEqual(out, [50, 11, 42, 23, 34]);
  assert.equal(peak, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/jev_client.js'`.

- [ ] **Step 3: Implement `src/jev_client.js`**

```js
export class JevError extends Error {
  constructor(status, message) {
    super(`Jev ${status}: ${message}`);
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callJev(body, { apiKey, endpoint, fetchImpl = globalThis.fetch, tries = 4, baseMs = 500, sleep = defaultSleep }) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new JevError('network', e?.message ?? String(e));
    }
    if (res.ok) return { data: await res.json(), ms: Date.now() - t0, attempts: attempt + 1 };
    if ((res.status === 429 || res.status === 529) && attempt < tries - 1) {
      await sleep(baseMs * 2 ** attempt);
      continue;
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new JevError(res.status, detail);
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jev_client.js test/jev_client.test.js
git commit -m "Add Jev client with 429/529 backoff and mapLimit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Pipeline (fan-out over an injected call)

**Files:**
- Create: `src/pipeline.js`
- Test: `test/pipeline.test.js`

**Interfaces:**
- Consumes: builders/readers (Task 6), `mapLimit` (Task 7)
- Produces (`call(body, label) → Promise<{ data, ms }>`):
  - `runQuery({ windows, query, call, limit, model }) → { perWindow: (QueryAnswers|null)[], failed: number[] }`. Throws on 401, or if every window fails.
  - `runStart({ windows, call, limit, model }) → { start: {[chunkId]: number|null} }`. Throws on 401, or if every window fails.
  - `runRefine({ lines, offset, query, call, model, maxLines }) → number|null` (never throws)

- [ ] **Step 1: Write the failing tests**

`test/pipeline.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, runStart, runRefine } from '../src/pipeline.js';
import { JevError } from '../src/jev_client.js';

const windows = [
  [{ id: 'C000', start: 0, text: 'a' }, { id: 'C001', start: 30, text: 'b' }],
  [{ id: 'C001', start: 30, text: 'b' }, { id: 'C002', start: 60, text: 'c' }],
];

// Answers every question: rel = 0.1 * chunk number, start = 0.5, best = last chunk.
function fakeCall({ failWindow = -1, status = 529 } = {}) {
  let n = 0;
  return async (body) => {
    const idx = n++;
    if (body.state.startsWith('C001') && failWindow === 1) throw new JevError(status, 'x');
    if (failWindow === 'all') throw new JevError(status, 'x');
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      const m = id.match(/^(rel|start)_C(\d+)$/);
      if (m) answers[id] = { noul: m[1] === 'rel' ? Number(m[2]) / 10 : 0.5 };
    }
    const ids = Object.keys(body.questions.best?.criteria ?? {});
    if (ids.length) answers.best = { choice: ids.at(-1) };
    if (body.questions.exists) answers.exists = { noul: 0.8 };
    if (body.questions.line) answers.line = { choice: Object.keys(body.questions.line.criteria)[1] };
    return { data: { answers }, ms: 1, idx };
  };
}

const base = { windows, query: 'q', limit: 10, model: 'm' };

test('runQuery merges nothing, returns per-window answers', async () => {
  const r = await runQuery({ ...base, call: fakeCall() });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.perWindow[0], { rel: { C000: 0, C001: 0.1 }, best: 'C001', exists: 0.8 });
  assert.deepEqual(r.perWindow[1].rel, { C001: 0.1, C002: 0.2 });
});

test('runQuery tolerates one failed window', async () => {
  const r = await runQuery({ ...base, call: fakeCall({ failWindow: 1 }) });
  assert.deepEqual(r.failed, [1]);
  assert.equal(r.perWindow[1], null);
});

test('runQuery throws on 401 and when all windows fail', async () => {
  await assert.rejects(runQuery({ ...base, call: fakeCall({ failWindow: 1, status: 401 }) }), (e) => e.status === 401);
  await assert.rejects(runQuery({ ...base, call: fakeCall({ failWindow: 'all' }) }), (e) => e.status === 529);
});

test('runStart merges windows into one map', async () => {
  const r = await runStart({ windows, call: fakeCall(), limit: 10, model: 'm' });
  assert.deepEqual(r.start, { C000: 0.5, C001: 0.5, C002: 0.5 });
});

test('runRefine returns an absolute line index, null on failure', async () => {
  const lines = [{ start: 0, text: 'a' }, { start: 1, text: 'b' }];
  assert.equal(await runRefine({ lines, offset: 40, query: 'q', call: fakeCall(), model: 'm', maxLines: 255 }), 41);
  assert.equal(await runRefine({ lines, offset: 40, query: 'q', call: async () => { throw new Error('x'); }, model: 'm', maxLines: 255 }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/pipeline.js'`.

- [ ] **Step 3: Implement `src/pipeline.js`**

```js
import {
  buildQueryRequest, readQueryAnswers, buildStartRequest, readStartAnswers, buildRefineRequest, readRefineAnswer,
} from './request_builder.js';
import { mapLimit } from './jev_client.js';

async function fanOut(windows, limit, fn) {
  let fatal = null;
  const out = await mapLimit(windows, limit, async (win, i) => {
    try {
      return await fn(win, i);
    } catch (e) {
      if (e?.status === 401 || e?.status === 'nokey') fatal = e;
      return { error: e };
    }
  });
  if (fatal) throw fatal;
  const failed = out.flatMap((r, i) => (r?.error ? [i] : []));
  if (windows.length && failed.length === windows.length) throw out[0].error;
  return { out, failed };
}

export async function runQuery({ windows, query, call, limit, model }) {
  const { out, failed } = await fanOut(windows, limit, async (win, i) => {
    const { data } = await call(buildQueryRequest(win, query, model), `query w${i}`);
    return readQueryAnswers(win, data);
  });
  return { perWindow: out.map((r) => (r?.error ? null : r)), failed };
}

export async function runStart({ windows, call, limit, model }) {
  const { out } = await fanOut(windows, limit, async (win, i) => {
    const { data } = await call(buildStartRequest(win, model), `start w${i}`);
    return readStartAnswers(win, data);
  });
  const start = {};
  for (const r of out) {
    if (r?.error) continue;
    for (const [id, v] of Object.entries(r)) if (start[id] == null) start[id] = v;
  }
  return { start };
}

export async function runRefine({ lines, offset, query, call, model, maxLines }) {
  try {
    const { data } = await call(buildRefineRequest(lines, offset, query, model, maxLines), 'refine');
    return readRefineAnswer(data);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.js test/pipeline.test.js
git commit -m "Add query/start/refine fan-out pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Background worker and options page (Phase 1 gate)

**Files:**
- Modify: `src/background.js` (replace placeholder)
- Create: `options/options.html`, `options/options.js`

**Interfaces:**
- Consumes: `CONFIG`, `callJev`, `JevError`, `runQuery`, `runStart`, `runRefine`, `buildTestRequest`
- Produces the runtime messages (all reply `{ ok: true, result } | { ok: false, error: { status, message } }`):
  - `{ type: 'testKey', apiKey? } → { ms, usage, answers }`
  - `{ type: 'prepStart', videoId, windows } → { start: {[chunkId]: number|null}, cached }`
  - `{ type: 'query', videoId, windows, query } → { perWindow, failed, cached }`
  - `{ type: 'refine', lines, offset, query } → { lineIdx: number|null }`

- [ ] **Step 1: Write `src/background.js`**

```js
import { CONFIG } from './config.js';
import { callJev, JevError } from './jev_client.js';
import { runQuery, runStart, runRefine } from './pipeline.js';
import { buildTestRequest } from './request_builder.js';

// Memory cache backed by storage.session (the worker can be killed when idle).
const memo = new Map();
async function cacheGet(key) {
  if (memo.has(key)) return memo.get(key);
  const o = await chrome.storage.session.get(key);
  if (key in o) {
    memo.set(key, o[key]);
    return o[key];
  }
  return undefined;
}
async function cacheSet(key, value) {
  memo.set(key, value);
  try { await chrome.storage.session.set({ [key]: value }); } catch {}
}

async function getKey(override) {
  if (override) return override;
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new JevError('nokey', 'No API key set');
  return apiKey;
}

function makeCall(apiKey) {
  return async (body, label) => {
    const r = await callJev(body, {
      apiKey, endpoint: CONFIG.endpoint, tries: CONFIG.retryTries, baseMs: CONFIG.retryBaseMs,
    });
    if (CONFIG.dev) {
      const n = Object.keys(body.questions).length;
      console.log(`[jev-yt] ${label}: ${r.ms} ms, ${n} questions, input_tokens=${r.data?.usage?.input_tokens ?? '?'}, attempts=${r.attempts}`);
    }
    return r;
  };
}

const inflight = new Map();

const handlers = {
  async testKey({ apiKey }) {
    const r = await makeCall(await getKey(apiKey))(buildTestRequest(CONFIG.model), 'test');
    if (CONFIG.dev) console.log('[jev-yt] test response', r.data);
    return { ms: r.ms, usage: r.data?.usage ?? null, answers: r.data?.answers ?? r.data };
  },

  async prepStart({ videoId, windows }) {
    const key = `start:${videoId}`;
    const hit = await cacheGet(key);
    if (hit) return { start: hit, cached: true };
    if (!inflight.has(key)) {
      const job = (async () => {
        const call = makeCall(await getKey());
        const { start } = await runStart({ windows, call, limit: CONFIG.concurrency, model: CONFIG.model });
        await cacheSet(key, start);
        return start;
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    return { start: await inflight.get(key), cached: false };
  },

  async query({ videoId, windows, query }) {
    const key = `q:${videoId}:${query}`;
    const hit = await cacheGet(key);
    if (hit) return { ...hit, cached: true };
    const call = makeCall(await getKey());
    const t0 = Date.now();
    const res = await runQuery({ windows, query, call, limit: CONFIG.concurrency, model: CONFIG.model });
    if (CONFIG.dev) console.log(`[jev-yt] query "${query}": ${windows.length} windows in ${Date.now() - t0} ms, failed=${JSON.stringify(res.failed)}`);
    if (!res.failed.length) await cacheSet(key, res);
    return { ...res, cached: false };
  },

  async refine({ lines, offset, query }) {
    const call = makeCall(await getKey());
    const lineIdx = await runRefine({ lines, offset, query, call, model: CONFIG.model, maxLines: CONFIG.maxRefineLines });
    return { lineIdx };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: { status: err?.status ?? 'error', message: err?.message ?? String(err) } }),
  );
  return true;
});
```

- [ ] **Step 2: Write `options/options.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Jev YT settings</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
    main { max-width: 480px; margin: 48px auto; padding: 0 16px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; border-radius: 8px; border: 1px solid #8886; }
    .row { display: flex; gap: 8px; margin-top: 12px; }
    button { padding: 8px 14px; font: inherit; border-radius: 8px; border: 1px solid #8886; cursor: pointer; }
    #status { min-height: 1.5em; margin-top: 12px; }
    .note { opacity: 0.7; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>Jev YT</h1>
    <label for="key">TypeSafe API key</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key">
    <div class="row">
      <button id="save">Save</button>
      <button id="test">Test key</button>
    </div>
    <p id="status" role="status"></p>
    <p class="note">Your key stays in this browser and is sent only to api.typesafe.ai.</p>
  </main>
  <script type="module" src="options.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `options/options.js`**

```js
const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

const MESSAGES = {
  401: 'Key rejected (401). Check it and try again.',
  422: 'Request rejected (422). Please report this.',
  429: 'Rate limited (429). Try again shortly.',
  529: 'TypeSafe is overloaded (529). Try again shortly.',
  network: "Can't reach TypeSafe. Check your connection.",
  nokey: 'Paste a key first.',
};

const { apiKey } = await chrome.storage.local.get('apiKey');
if (apiKey) $('key').value = apiKey;

$('save').addEventListener('click', async () => {
  const value = $('key').value.trim();
  await chrome.storage.local.set({ apiKey: value });
  setStatus(value ? 'Saved.' : 'Key cleared.');
});

$('test').addEventListener('click', async () => {
  setStatus('Testing…');
  const res = await chrome.runtime.sendMessage({ type: 'testKey', apiKey: $('key').value.trim() || undefined });
  if (res?.ok) {
    const tokens = res.result.usage?.input_tokens;
    setStatus(`Key works (${res.result.ms} ms${tokens != null ? `, ${tokens} input tokens` : ''}).`);
  } else {
    setStatus(MESSAGES[res?.error?.status] ?? `Error: ${res?.error?.message ?? 'unknown'}`);
  }
});
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: PASS (no new tests; background and options are Chrome glue).

- [ ] **Step 5: Manual gate (user, real key)**

1. `chrome://extensions` → Jev YT → reload.
2. Open the extension's options → paste the key → **Save** → **Test key**. Expect "Key works (N ms…)".
3. Open the service worker console (`chrome://extensions` → Jev YT → "service worker") and inspect the `test response` log. **Record the exact response shape** (is it `{ answers: {...}, usage }` or bare ids?), and adjust `answersOf` in `request_builder.js` plus its test if it differs.
4. Enter a wrong key → **Test key** → expect "Key rejected (401)".

- [ ] **Step 6: Commit**

```bash
git add src/background.js options
git commit -m "Phase 1: background worker, caching, options page with Test key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Scoring and decision logic

**Files:**
- Create: `src/scoring.js`
- Test: `test/scoring.test.js`

**Interfaces:**
- Consumes: `chunkIndex` (Task 4)
- Produces:
  - `mergeByChunk(n, maps: ({[chunkId]: number|null}|null|undefined)[]) → (number|null)[]` (averages overlaps)
  - `smooth(values: (number|null)[], kernel: number[]) → number[]`
  - `startsFromChapters(chunks, chapters, hi, lo) → number[]`
  - `findSegments(rel, relT, gap) → { from, to, score }[]`
  - `walkBack(from, start, maxSteps, startT) → number`
  - `decide({ chunks, rel, start, bests, exists, unknown, highlightOnly, config }) → { kind: 'absent'|'highlight'|'jump', heat: number[], segments: Segment[], maxExists: number, target: Segment|null }` where `Segment = { from, to, score, startIdx, time }`, sorted by score, descending.

- [ ] **Step 1: Write the failing tests**

`test/scoring.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeByChunk, smooth, startsFromChapters, findSegments, walkBack, decide,
} from '../src/scoring.js';
import { CONFIG } from '../src/config.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('mergeByChunk averages overlaps and leaves gaps null', () => {
  const r = mergeByChunk(4, [{ C000: 0.2, C001: 0.4 }, null, { C001: 0.8, C002: 1, C003: null }]);
  assert.ok(close(r[0], 0.2) && close(r[1], 0.6) && close(r[2], 1));
  assert.equal(r[3], null);
});

test('smooth renormalizes at the edges and treats null as 0', () => {
  const r = smooth([0, 1, null], [0.25, 0.5, 0.25]);
  assert.ok(close(r[0], 1 / 3) && close(r[1], 0.5) && close(r[2], 1 / 3));
});

test('startsFromChapters marks the chunk containing each chapter start', () => {
  const chunks = [{ start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 90 }];
  assert.deepEqual(startsFromChapters(chunks, [{ start: 0 }, { start: 45 }], 1, 0.3), [1, 1, 0.3]);
  const gap = [{ start: 0, end: 30 }, { start: 40, end: 70 }];
  assert.deepEqual(startsFromChapters(gap, [{ start: 35 }], 1, 0.3), [0.3, 1]);
});

test('findSegments allows a one-chunk gap', () => {
  const segs = findSegments([0, 0.9, 0.8, 0.1, 0.7, 0, 0, 0.6], 0.5, 1);
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].from, segs[0].to], [1, 4]);
  assert.ok(close(segs[0].score, 2.5));
  assert.deepEqual([segs[1].from, segs[1].to], [7, 7]);
});

test('walkBack finds the nearest topic start within range', () => {
  const start = [0.9, 0.1, 0.1, 0.1, 0.1];
  assert.equal(walkBack(3, start, 3, 0.5), 0);
  assert.equal(walkBack(4, start, 3, 0.5), 4);
  assert.equal(walkBack(0, start, 3, 0.5), 0);
});

// 10 chunks of 30 s. `peaks` sets rel values; everything else is 0.05.
function scenario({ peaks, exists = [0.9], bests = [null], start, unknown, highlightOnly = false }) {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ start: i * 30, end: (i + 1) * 30 }));
  const rel = chunks.map((_, i) => peaks[i] ?? 0.05);
  return decide({
    chunks, rel, exists, bests, highlightOnly, config: CONFIG,
    start: start ?? chunks.map(() => 0.1),
    unknown: unknown ?? chunks.map(() => false),
  });
}

test('decide: clear single topic jumps to walked-back start', () => {
  const start = Array.from({ length: 10 }, (_, i) => (i === 4 ? 0.8 : 0.1));
  const d = scenario({ peaks: { 5: 0.9, 6: 0.95, 7: 0.8 }, bests: [6], start });
  assert.equal(d.kind, 'jump');
  assert.equal(d.target.startIdx, 4);
  assert.equal(d.target.time, 4 * 30 - CONFIG.seekPadSec);
  assert.equal(d.heat.length, 10);
});

test('decide: two similar segments fall back to highlight', () => {
  const d = scenario({ peaks: { 1: 0.9, 2: 0.9, 6: 0.9, 7: 0.85 } });
  assert.equal(d.kind, 'highlight');
  assert.equal(d.segments.length, 2);
});

test('decide: best-choice boost can reorder segments', () => {
  const d = scenario({ peaks: { 1: 1.0, 6: 0.55, 7: 0.55 }, bests: [1] });
  assert.equal(d.segments[0].from, 1); // 1.0 * 1.2 = 1.2 > 1.1
});

test('decide: highlight-only never jumps', () => {
  const d = scenario({ peaks: { 5: 0.9, 6: 0.95 }, highlightOnly: true });
  assert.equal(d.kind, 'highlight');
});

test('decide: low exists means absent', () => {
  assert.equal(scenario({ peaks: { 5: 0.9 }, exists: [0.2] }).kind, 'absent');
});

test('decide: no segment above threshold means absent', () => {
  assert.equal(scenario({ peaks: {}, exists: [0.8] }).kind, 'absent');
});

test('decide: middling exists highlights instead of jumping', () => {
  assert.equal(scenario({ peaks: { 5: 0.9, 6: 0.95 }, exists: [0.5] }).kind, 'highlight');
});

test('decide: unknown chunk next to the winner blocks the jump', () => {
  const unknown = Array.from({ length: 10 }, (_, i) => i === 8);
  assert.equal(scenario({ peaks: { 5: 0.9, 6: 0.95, 7: 0.8 }, unknown }).kind, 'highlight');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/scoring.js'`.

- [ ] **Step 3: Implement `src/scoring.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scoring.js test/scoring.test.js
git commit -m "Add scoring: merge, smoothing, segments, walk-back, decision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End to end in the console (Phase 2 gate)

**Files:**
- Modify: `src/content.js` (full replacement below)

**Interfaces:**
- Consumes: everything above; runtime messages from Task 9
- Produces: `globalThis.jev = { ask(text): Promise<Decision|undefined>, video, last }` in the content-script (isolated) console context. `video` gains `chunks`, `windows`, `startPromise`.

- [ ] **Step 1: Replace `src/content.js`**

```js
(async () => {
  const load = (p) => import(chrome.runtime.getURL(p));
  const [
    { CONFIG }, { makeBridge }, { getTranscript }, { parseChapters }, { formatTime },
    chunker, { parseQuery }, scoring,
  ] = await Promise.all([
    load('src/config.js'), load('src/bridge_client.js'), load('src/transcript.js'),
    load('src/transcript_parse.js'), load('src/time.js'), load('src/chunker.js'),
    load('src/query.js'), load('src/scoring.js'),
  ]);

  const log = (...a) => console.log('[jev-yt]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = makeBridge();
  const video = { id: null, gen: 0, status: 'idle' };
  let last = null;
  let cursor = 0;

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.ok) return res.result;
    const err = new Error(res?.error?.message ?? 'no response from background');
    err.status = res?.error?.status;
    throw err;
  }

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  async function waitForInfo(videoId, gen) {
    for (let i = 0; i < 30; i++) {
      if (gen !== video.gen) return null;
      const info = await bridge.call('videoInfo', { videoId }).catch(() => null);
      if (info?.ready) return info;
      await sleep(500);
    }
    return null;
  }

  async function prepare() {
    const videoId = currentVideoId();
    if (videoId === video.id) return;
    const gen = ++video.gen;
    last = null;
    Object.assign(video, {
      id: videoId, status: videoId ? 'preparing' : 'idle',
      lines: null, chapters: [], chunks: null, windows: null, startPromise: null, durationSec: 0,
    });
    if (!videoId) return;

    const t0 = performance.now();
    const info = await waitForInfo(videoId, gen);
    if (gen !== video.gen) return;
    if (!info) {
      video.status = 'unavailable';
      return log('no player data for', videoId);
    }
    const data = JSON.parse(info.dataJson);
    const chapters = parseChapters(data);
    const result = await getTranscript({ bridge, data, durationSec: info.duration, log });
    if (gen !== video.gen) return;
    if (!result) {
      video.status = 'unavailable';
      return log('No transcript for this video');
    }

    const chunkSec = chunker.chunkSecondsFor(info.duration, CONFIG.chunkRules);
    const chunks = chunker.buildChunks(result.lines, chunkSec, CONFIG.sentenceSlack);
    const windows = chunker.buildWindows(chunks, CONFIG.windowSize, CONFIG.windowOverlap);
    const startPromise = chapters.length
      ? Promise.resolve(scoring.startsFromChapters(chunks, chapters, CONFIG.chapterStart, CONFIG.chapterOther))
      : send({ type: 'prepStart', videoId, windows })
        .then((r) => scoring.mergeByChunk(chunks.length, [r.start]))
        .catch((e) => {
          log('start pass failed:', e.message);
          return chunks.map(() => 0);
        });

    Object.assign(video, {
      status: 'ready', lines: result.lines, chapters, chunks, windows, startPromise, durationSec: info.duration,
    });
    log(`${videoId} "${info.title}" ready via ${result.method} in ${Math.round(performance.now() - t0)} ms: ` +
      `${result.lines.length} lines → ${chunks.length} chunks of ~${chunkSec}s → ${windows.length} windows; ` +
      `${chapters.length ? `${chapters.length} chapters` : 'no chapters, start pass running'}`);
  }

  function seek(t) {
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  }

  function cycle(dir) {
    const segs = last?.segments ?? [];
    if (!segs.length) return log('no matches to cycle');
    cursor = (cursor + dir + segs.length) % segs.length;
    seek(segs[cursor].time);
    log(`match ${cursor + 1}/${segs.length} → ${formatTime(segs[cursor].time)}`);
  }

  async function ask(text) {
    const parsed = parseQuery(text);
    if (parsed.kind === 'empty') return log('empty query');
    if (parsed.kind === 'next') return cycle(1);
    if (parsed.kind === 'back') return cycle(-1);
    if (video.status !== 'ready') return log(`not ready (${video.status})`);

    const { id: videoId, gen, chunks, windows, lines } = video;
    const t0 = performance.now();
    log(`searching "${parsed.query}"${parsed.highlightOnly ? ' (highlight only)' : ''}…`);
    const res = await send({ type: 'query', videoId, windows, query: parsed.query });
    if (gen !== video.gen) return;

    const rel = scoring.mergeByChunk(chunks.length, res.perWindow.map((w) => w?.rel));
    const exists = res.perWindow.map((w) => w?.exists ?? null);
    const bests = res.perWindow.map((w) => (w?.best ? chunker.chunkIndex(w.best) : null));
    const unknown = rel.map((v) => v == null);
    const start = await video.startPromise;
    const d = scoring.decide({
      chunks, rel, start, bests, exists, unknown, highlightOnly: parsed.highlightOnly, config: CONFIG,
    });
    last = d;
    cursor = 0;

    console.table(d.segments.slice(0, 8).map((s) => ({
      from: formatTime(chunks[s.from].start), to: formatTime(chunks[s.to].end),
      score: +s.score.toFixed(2), seek: formatTime(s.time),
    })));
    log(`maxExists=${d.maxExists.toFixed(2)} failedWindows=${JSON.stringify(res.failed)} cached=${res.cached}`);

    if (d.kind === 'jump') {
      let time = d.target.time;
      const s = d.target.startIdx;
      const e = Math.min(Math.max(d.target.from, s + 1), chunks.length - 1);
      const from = chunks[s].lineIdx[0];
      const to = chunks[e].lineIdx[1];
      try {
        const { lineIdx } = await send({ type: 'refine', lines: lines.slice(from, to + 1), offset: from, query: parsed.query });
        if (lineIdx != null && lines[lineIdx]) time = Math.max(0, lines[lineIdx].start - CONFIG.refinePadSec);
        log(`refine → ${lineIdx != null ? `line ${lineIdx}: "${lines[lineIdx]?.text}"` : 'none, using chunk start'}`);
      } catch (err) {
        log('refine failed:', err.message);
      }
      if (gen !== video.gen) return;
      seek(time);
      log(`JUMP → ${formatTime(time)}`);
    } else if (d.kind === 'highlight') {
      log(`HIGHLIGHT: found ${d.segments.length} spots; jev.ask("next") to cycle`);
    } else {
      log('ABSENT: Not discussed in this video');
    }
    log(`total ${Math.round(performance.now() - t0)} ms`);
    return d;
  }

  globalThis.jev = {
    ask: (text) => ask(text).catch((e) => log(`error (${e.status ?? '?'}): ${e.message}`)),
    video,
    get last() { return last; },
  };
  document.addEventListener('yt-navigate-finish', prepare);
  prepare();
})();
```

- [ ] **Step 2: Run the unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Manual gate (user, real key, long podcast)**

1. Reload the extension, then reload the YouTube tab.
2. In DevTools' console context dropdown, pick **Jev YT** (the content-script context), not `top`.
3. Wait for `ready via … N windows`.
4. Run a query for a topic clearly discussed in the video, e.g. `await jev.ask("skip to where he talks about caffeine")`. Expect `JUMP → h:mm:ss` and the video seeks there.
5. Run a query for a topic that isn't in the video, e.g. `await jev.ask("the stock market")`. Expect `ABSENT`.
6. Run `await jev.ask("where does he mention sleep")`. Expect `HIGHLIGHT`; then run `jev.ask("next")` to cycle.
7. In the service worker console, record for one window request: **ms, number of questions and input_tokens**. This is the Phase 1 latency and cost measurement from the spec.

Done when step 4 lands within about 60 s of the true start on a long podcast.

- [ ] **Step 4: Commit**

```bash
git add src/content.js
git commit -m "Phase 2: end-to-end query in console with refine jump

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After this plan

Write plan 2 (spec phases 3–6: heatmap and toast, automatic decision UX with Undo, Right Option voice and typing, polish, caching of transcripts in `storage.session`, README with privacy note, eval) using what the three manual gates found: the transcript method order, the response shape, and the measured latency.
