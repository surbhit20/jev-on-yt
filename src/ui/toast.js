// Wispr-style toast inside the YouTube player. Text is set with textContent only.
const SVG_NS = 'http://www.w3.org/2000/svg';
// Stop these from reaching the player (clicks would toggle play/pause, keys would trigger shortcuts).
const SWALLOW = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'wheel'];

function el(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function createToast() {
  let root = null;
  let timer = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    root?.remove();
    root = null;
  }

  function closeButton(dismissMs) {
    const btn = el('button', 'jev-close', '✕');
    btn.setAttribute('aria-label', 'Close');
    btn.addEventListener('click', hide);
    if (dismissMs) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 28 28');
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', '14');
      ring.setAttribute('cy', '14');
      ring.setAttribute('r', '13');
      ring.setAttribute('class', 'jev-ring');
      ring.style.setProperty('--jev-ms', `${dismissMs}ms`);
      svg.append(ring);
      btn.append(svg);
    }
    return btn;
  }

  function show({ icon = '', title = '', body = '', actions = [], dismissMs = 0, input = null }) {
    hide();
    const host = document.getElementById('movie_player');
    if (!host) return null;

    root = el('div', 'jev-toast');
    root.setAttribute('role', 'status');
    for (const type of SWALLOW) root.addEventListener(type, (e) => e.stopPropagation());

    const head = el('div', 'jev-toast-head');
    if (icon) head.append(el('span', 'jev-toast-icon', icon));
    const titleEl = el('span', 'jev-toast-title', title);
    head.append(titleEl, closeButton(dismissMs));
    root.append(head);

    const bodyEl = el('div', 'jev-toast-body', body);
    bodyEl.hidden = !body;
    root.append(bodyEl);

    let inputEl = null;
    if (input) {
      inputEl = el('input', 'jev-input');
      inputEl.type = 'text';
      inputEl.placeholder = input.placeholder ?? '';
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = inputEl.value.trim();
          if (text) input.onSubmit(text);
        } else if (e.key === 'Escape') {
          hide();
        }
      });
      root.append(inputEl);
    }

    if (actions.length) {
      const row = el('div', 'jev-toast-actions');
      for (const a of actions) {
        const btn = el('button', a.primary ? 'jev-btn jev-primary' : 'jev-btn', a.label);
        btn.addEventListener('click', () => a.onClick());
        row.append(btn);
      }
      root.append(row);
    }

    host.append(root);
    if (inputEl) setTimeout(() => inputEl.focus(), 0);
    if (dismissMs) timer = setTimeout(hide, dismissMs);

    return {
      setTitle(t) { titleEl.textContent = t; },
      setBody(t) { bodyEl.textContent = t; bodyEl.hidden = !t; },
    };
  }

  return { show, hide, isOpen: () => root !== null };
}
