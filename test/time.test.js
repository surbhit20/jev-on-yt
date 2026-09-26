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
