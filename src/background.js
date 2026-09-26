import { CONFIG } from './config.js';
import { callJev, JevError } from './jev_client.js';
import { runQuery, runStart, runRefine, runIntent } from './pipeline.js';
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
        const { start, failed } = await runStart({ windows, call, limit: CONFIG.concurrency, model: CONFIG.model });
        if (!failed.length) await cacheSet(key, start);
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

  async intent({ text }) {
    const key = `i:${String(text).trim().toLowerCase()}`;
    const hit = await cacheGet(key);
    if (hit) return hit;
    const result = await runIntent({ text, call: makeCall(await getKey()), model: CONFIG.model });
    if (result) await cacheSet(key, result);
    return result;
  },

  async refine({ lines, offset, query }) {
    const call = makeCall(await getKey());
    const lineIdx = await runRefine({ lines, offset, query, call, model: CONFIG.model, maxLines: CONFIG.maxRefineLines });
    return { lineIdx };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return {};
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

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
