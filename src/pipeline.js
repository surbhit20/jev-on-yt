import {
  buildQueryRequest, readQueryAnswers, buildStartRequest, readStartAnswers, buildRefineRequest, readRefineAnswer,
  buildIntentRequest, readIntentAnswer,
} from './request_builder.js';
import { mapLimit } from './jev_client.js';
import { startSignal, decideFromAnswers, refineRange, jumpTimeFor } from './search.js';

async function fanOut(windows, limit, fn) {
  let fatal = null;
  const out = await mapLimit(windows, limit, async (win, i) => {
    if (fatal) return { error: fatal };
    try {
      return await fn(win, i);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403 || e?.status === 'nokey') fatal = e;
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
  const { out, failed } = await fanOut(windows, limit, async (win, i) => {
    const { data } = await call(buildStartRequest(win, model), `start w${i}`);
    return readStartAnswers(win, data);
  });
  const start = {};
  for (const r of out) {
    if (r?.error) continue;
    for (const [id, v] of Object.entries(r)) if (start[id] == null) start[id] = v;
  }
  return { start, failed };
}

export async function runRefine({ lines, offset, query, call, model, maxLines }) {
  try {
    const { data } = await call(buildRefineRequest(lines, offset, query, model, maxLines), 'refine');
    return readRefineAnswer(data);
  } catch {
    return null;
  }
}

// go / show intent for the user's words. Never throws: null means "use the word rule".
export async function runIntent({ text, call, model }) {
  try {
    const { data } = await call(buildIntentRequest(text, model), 'intent');
    return readIntentAnswer(data);
  } catch {
    return null;
  }
}

// The whole search against Jev, as the extension runs it (used by the evals): query, start signal,
// decision, refined time for the top segment. `jumpTime` is null when nothing was found.
export async function runSearch({ chunks, windows, lines, chapters, query, highlightOnly = false, call, config }) {
  const opts = { call, limit: config.concurrency, model: config.model };
  const [res, st] = await Promise.all([
    runQuery({ windows, query, ...opts }),
    chapters.length ? null : runStart({ windows, ...opts }),
  ]);
  const start = startSignal(chunks, chapters, st?.start, config);
  const decision = decideFromAnswers({ chunks, perWindow: res.perWindow, start, highlightOnly, config });
  const top = decision.segments[0];
  if (decision.kind === 'absent' || !top) return { decision, jumpTime: null, failed: res.failed };
  const { from, to } = refineRange(chunks, top);
  const lineIdx = await runRefine({
    lines: lines.slice(from, to + 1), offset: from, query, call, model: config.model, maxLines: config.maxRefineLines,
  });
  return { decision, jumpTime: jumpTimeFor(lines, top, lineIdx, config), failed: res.failed };
}
