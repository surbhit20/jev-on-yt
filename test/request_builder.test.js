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

import { buildIntentRequest, readIntentAnswer } from '../src/request_builder.js';

test('buildIntentRequest: one Choice over go/show, the user words as state', () => {
  const b = buildIntentRequest('where does he mention "naps"', 'm');
  assert.equal(b.model, 'm');
  assert.equal(b.state, 'User request: "where does he mention \\"naps\\""');
  assert.deepEqual(Object.keys(b.questions), ['intent']);
  assert.equal(b.questions.intent.type, 'choice');
  assert.deepEqual(Object.keys(b.questions.intent.criteria), ['go', 'show']);
});

test('readIntentAnswer: choice with confidence, falling back to its probability', () => {
  assert.deepEqual(readIntentAnswer({ answers: { intent: { choice: 'show', confidence: 0.9 } } }), { choice: 'show', confidence: 0.9 });
  assert.deepEqual(readIntentAnswer({ answers: { intent: { choice: 'go', probabilities: { go: 0.7, show: 0.3 } } } }), { choice: 'go', confidence: 0.7 });
  assert.equal(readIntentAnswer({ answers: { intent: { choice: 'maybe' } } }), null);
  assert.equal(readIntentAnswer({}), null);
});
