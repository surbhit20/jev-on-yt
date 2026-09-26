import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaGuard } from '../src/media_guard.js';

function fakeVideo({ paused = false, muted = false } = {}) {
  const calls = [];
  return {
    paused, muted, calls,
    pause() { calls.push('pause'); this.paused = true; },
    play() { calls.push('play'); this.paused = false; return Promise.resolve(); },
  };
}

test('pause mode: pauses a playing video and resumes it on release', () => {
  const v = fakeVideo();
  const g = createMediaGuard(() => v, 'pause');
  g.engage();
  assert.equal(v.paused, true);
  g.release();
  assert.equal(v.paused, false);
  assert.deepEqual(v.calls, ['pause', 'play']);
});

test('pause mode: a video that was already paused stays paused', () => {
  const v = fakeVideo({ paused: true });
  const g = createMediaGuard(() => v, 'pause');
  g.engage();
  g.release();
  assert.equal(v.paused, true);
  assert.deepEqual(v.calls, []);
});

test('mute mode: mutes and restores the previous mute state', () => {
  const v = fakeVideo();
  const g = createMediaGuard(() => v, 'mute');
  g.engage();
  assert.equal(v.muted, true);
  g.release();
  assert.equal(v.muted, false);
  const already = fakeVideo({ muted: true });
  const g2 = createMediaGuard(() => already, 'mute');
  g2.engage();
  g2.release();
  assert.equal(already.muted, true);
});

test('engage twice keeps the first saved state; release without engage is a no-op', () => {
  const v = fakeVideo();
  const g = createMediaGuard(() => v, 'pause');
  g.release();
  g.engage();
  g.engage();
  g.release();
  assert.deepEqual(v.calls, ['pause', 'play']);
});

test('reset drops the saved state without touching the video (video changed)', () => {
  const v = fakeVideo();
  const g = createMediaGuard(() => v, 'pause');
  g.engage();
  g.reset();
  g.release();
  assert.deepEqual(v.calls, ['pause']);
});

test('none mode and missing video do nothing', () => {
  const v = fakeVideo();
  const g = createMediaGuard(() => v, 'none');
  g.engage();
  g.release();
  assert.deepEqual(v.calls, []);
  const g2 = createMediaGuard(() => null, 'pause');
  g2.engage();
  g2.release();
});
