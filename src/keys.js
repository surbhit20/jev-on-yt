// Right Option push-to-talk. Pure: key events, clock and timers are injected so it can be unit tested.
// keydown/keyup return true when the caller should preventDefault() and stopImmediatePropagation().
export function createKeyWatcher({
  holdMs, doubleTapMs, isEditable, on,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let armed = false; // Right Option is down and counts as ours
  let holdTimer = null;
  let holding = false;
  let lastTapAt = -Infinity;

  const isTrigger = (e) => e.code === 'AltRight';

  function cancel() {
    armed = false;
    if (holdTimer !== null) {
      clearTimer(holdTimer);
      holdTimer = null;
    }
    if (holding) {
      holding = false;
      on.holdCancel?.();
    }
  }

  function keydown(e) {
    if (isTrigger(e)) {
      if (e.repeat || armed) return armed;
      if (isEditable(e.target)) return false;
      armed = true;
      holdTimer = setTimer(() => {
        holdTimer = null;
        holding = true;
        on.holdStart?.();
      }, holdMs);
      return true;
    }
    if (armed) {
      cancel();
      return false;
    }
    if (isEditable(e.target)) return false;
    if (e.key === 'Escape') return !!on.escape?.();
    if (e.key === 'ArrowRight') return !!on.arrow?.(1);
    if (e.key === 'ArrowLeft') return !!on.arrow?.(-1);
    return false;
  }

  function keyup(e) {
    if (!isTrigger(e) || !armed) return false;
    armed = false;
    if (holding) {
      holding = false;
      on.holdEnd?.();
      return true;
    }
    if (holdTimer !== null) {
      clearTimer(holdTimer);
      holdTimer = null;
    }
    const t = now();
    if (t - lastTapAt <= doubleTapMs) {
      lastTapAt = -Infinity;
      on.doubleTap?.();
    } else {
      lastTapAt = t;
    }
    return true;
  }

  return {
    keydown,
    keyup,
    mousedown() { if (armed) cancel(); },
    blur() { if (armed) cancel(); },
  };
}
