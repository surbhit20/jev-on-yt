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

import { resolveHighlightOnly } from '../src/query.js';

test('resolveHighlightOnly: confident Jev intent wins, otherwise the word rule', () => {
  assert.equal(resolveHighlightOnly({ choice: 'show', confidence: 0.9 }, false, 0.6), true);
  assert.equal(resolveHighlightOnly({ choice: 'go', confidence: 0.9 }, true, 0.6), false);
  assert.equal(resolveHighlightOnly({ choice: 'show', confidence: 0.5 }, false, 0.6), false);
  assert.equal(resolveHighlightOnly(null, true, 0.6), true);
});
