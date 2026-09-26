import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyWatcher } from '../src/keys.js';

function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (i) => timers.delete(i),
    advance(ms) {
      t += ms;
      for (const [i, x] of [...timers]) if (x.at <= t) { timers.delete(i); x.fn(); }
    },
  };
}

function setup({ escape = () => false, arrow = () => false } = {}) {
  const clock = fakeClock();
  const calls = [];
  const w = createKeyWatcher({
    holdMs: 250,
    doubleTapMs: 350,
    isEditable: (t) => t === 'input',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    on: {
      holdStart: () => calls.push('holdStart'),
      holdEnd: () => calls.push('holdEnd'),
      holdCancel: () => calls.push('holdCancel'),
      doubleTap: () => calls.push('doubleTap'),
      escape: () => { calls.push('escape'); return escape(); },
      arrow: (d) => { calls.push(`arrow${d}`); return arrow(d); },
    },
  });
  return { w, clock, calls };
}

const RO = { code: 'AltRight', key: 'Alt', target: 'body' };
const key = (k, target = 'body') => ({ code: `Key${k}`, key: k, target });

test('hold Right Option starts and ends listening', () => {
  const { w, clock, calls } = setup();
  assert.equal(w.keydown(RO), true);
  clock.advance(249);
  assert.deepEqual(calls, []);
  clock.advance(1);
  assert.deepEqual(calls, ['holdStart']);
  assert.equal(w.keyup(RO), true);
  assert.deepEqual(calls, ['holdStart', 'holdEnd']);
});

test('key repeat while held is swallowed and does not restart', () => {
  const { w, clock, calls } = setup();
  w.keydown(RO);
  clock.advance(300);
  assert.equal(w.keydown({ ...RO, repeat: true }), true);
  w.keyup(RO);
  assert.deepEqual(calls, ['holdStart', 'holdEnd']);
});

test('two quick taps are a double tap', () => {
  const { w, clock, calls } = setup();
  w.keydown(RO); clock.advance(80); w.keyup(RO);
  clock.advance(150);
  w.keydown(RO); clock.advance(80); w.keyup(RO);
  assert.deepEqual(calls, ['doubleTap']);
});

test('taps too far apart are not a double tap', () => {
  const { w, clock, calls } = setup();
  w.keydown(RO); clock.advance(80); w.keyup(RO);
  clock.advance(500);
  w.keydown(RO); clock.advance(80); w.keyup(RO);
  assert.deepEqual(calls, []);
});

test('another key before the hold starts cancels silently (Option+E typing)', () => {
  const { w, clock, calls } = setup();
  w.keydown(RO);
  clock.advance(100);
  assert.equal(w.keydown(key('E')), false);
  clock.advance(500);
  assert.equal(w.keyup(RO), false);
  assert.deepEqual(calls, []);
});

test('another key while holding cancels the hold', () => {
  const { w, clock, calls } = setup();
  w.keydown(RO);
  clock.advance(300);
  w.keydown(key('E'));
  w.keyup(RO);
  assert.deepEqual(calls, ['holdStart', 'holdCancel']);
});

test('mouse down or window blur cancels', () => {
  const a = setup();
  a.w.keydown(RO); a.clock.advance(300); a.w.mousedown(); a.w.keyup(RO);
  assert.deepEqual(a.calls, ['holdStart', 'holdCancel']);
  const b = setup();
  b.w.keydown(RO); b.clock.advance(100); b.w.blur(); b.clock.advance(500);
  assert.deepEqual(b.calls, []);
});

test('ignored while typing in an editable field', () => {
  const { w, clock, calls } = setup();
  assert.equal(w.keydown({ ...RO, target: 'input' }), false);
  clock.advance(500);
  assert.equal(w.keyup({ ...RO, target: 'input' }), false);
  assert.equal(w.keydown({ code: 'ArrowRight', key: 'ArrowRight', target: 'input' }), false);
  assert.deepEqual(calls, []);
});

test('Escape and arrows are forwarded; handled flag comes from the callback', () => {
  const { w, calls } = setup({ escape: () => true, arrow: (d) => d === 1 });
  assert.equal(w.keydown({ code: 'Escape', key: 'Escape', target: 'body' }), true);
  assert.equal(w.keydown({ code: 'ArrowRight', key: 'ArrowRight', target: 'body' }), true);
  assert.equal(w.keydown({ code: 'ArrowLeft', key: 'ArrowLeft', target: 'body' }), false);
  assert.equal(w.keydown(key('K')), false);
  assert.deepEqual(calls, ['escape', 'arrow1', 'arrow-1']);
});
