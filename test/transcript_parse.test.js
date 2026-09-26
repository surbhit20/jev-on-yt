import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findAll, findTranscriptParams, parseTranscriptResponse, parseChapters, linesFromPanel, parseJson3,
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

test('parseJson3: skips no-segs and empty-text events, cleans, fills ends', () => {
  const lines = parseJson3(fixture('timedtext_json3.json'));
  assert.deepEqual(lines, [
    { start: 0, end: 2.48, text: '[Music]' },
    { start: 0.32, end: 4.64, text: 'welcome to the show' },
    { start: 5, end: 7, text: 'last' },
  ]);
  assert.deepEqual(parseJson3({}), []);
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
