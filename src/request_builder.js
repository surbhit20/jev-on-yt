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
