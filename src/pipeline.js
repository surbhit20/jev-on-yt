import {
  buildQueryRequest, readQueryAnswers, buildStartRequest, readStartAnswers, buildRefineRequest, readRefineAnswer,
} from './request_builder.js';
import { mapLimit } from './jev_client.js';

async function fanOut(windows, limit, fn) {
  let fatal = null;
  const out = await mapLimit(windows, limit, async (win, i) => {
    if (fatal) return { error: fatal };
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
