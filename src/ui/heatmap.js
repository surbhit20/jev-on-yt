import { heatCells } from '../heat_layout.js';

// Heat layer inside YouTube's progress bar. Cells use % positions, so resize, theater and
// fullscreen need no observers. The layer is re-created if YouTube rebuilds the bar.
export function createHeatmap({ onCellClick, revealTickMs }) {
  let layer = null;
  let cells = [];
  let pulseTimer = null;
  let revealTimer = null;

  const bar = () => document.querySelector('#movie_player .ytp-progress-bar');

  function ensureLayer() {
    const b = bar();
    if (!b) return null;
    if (layer?.parentElement === b) return layer;
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'jev-heat';
    b.append(layer);
    return layer;
  }

  function cellEl(c) {
    const d = document.createElement('div');
    d.className = 'jev-cell';
    d.dataset.idx = String(c.idx);
    d.style.left = `${c.left}%`;
    d.style.width = `${c.width}%`;
    d.style.setProperty('--jev-a', c.alpha.toFixed(2));
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onCellClick(c.idx);
    });
    return d;
  }

  function render({ chunks, heat, durationSec, floor }) {
    cells = heatCells(chunks, heat, durationSec, floor);
    ensureLayer()?.replaceChildren(...cells.map(cellEl));
  }

  function shimmer(on) {
    if (!on && !layer) return;
    ensureLayer()?.classList.toggle('jev-shimmer', on);
  }

  function pulse(from, to, ms) {
    clearTimeout(pulseTimer);
    for (const d of layer?.querySelectorAll('.jev-cell') ?? []) {
      const i = Number(d.dataset.idx);
      d.classList.toggle('jev-pulse', i >= from && i <= to);
    }
    pulseTimer = setTimeout(() => {
      for (const d of layer?.querySelectorAll('.jev-pulse') ?? []) d.classList.remove('jev-pulse');
    }, ms);
  }

  // Keep YouTube's controls (and so the progress bar) visible for `ms` by nudging the player.
  function reveal(ms) {
    clearTimeout(revealTimer);
    const player = document.getElementById('movie_player');
    if (!player) return;
    const until = Date.now() + ms;
    const tick = () => {
      if (Date.now() > until) return;
      const r = player.getBoundingClientRect();
      player.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      revealTimer = setTimeout(tick, revealTickMs);
    };
    tick();
  }

  function clear() {
    clearTimeout(pulseTimer);
    clearTimeout(revealTimer);
    cells = [];
    layer?.remove();
    layer = null;
  }

  return { render, shimmer, pulse, reveal, clear, hasCells: () => cells.length > 0 };
}
