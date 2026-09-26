// Runs in the page's MAIN world. The only code that touches YouTube internals.
(() => {
  const REQ = 'jev-yt:req';
  const RES = 'jev-yt:res';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');

  // Mirror config.js-style tunables: this is a classic MAIN-world script and can't import
  // src/config.js (module-only), so these timing constants live here instead.
  const CAPTIONS_TIMEOUT_MS = 5000;
  const POLL_MS = 100;
  const MAX_CAPTURED = 5;
  const WAS_ON_KICK_MS = 2000; // CC on but nothing downloaded yet: toggle CC to force a download
  const TRACK_SWITCH_AFTER_MS = 1500; // CC turned on by us: then request an English track explicitly

  // Capture the player's own /api/timedtext response, keyed by video id.
  const captured = new Map();
  const isEnglishLang = (lang) => lang === 'en' || String(lang ?? '').startsWith('en-');
  const capturedIsEnglish = (entry) => !!entry && isEnglishLang(entry.lang) && !entry.tlang;
  function captureIfTimedtext(url, body) {
    try {
      if (typeof url !== 'string' || !url.includes('/api/timedtext')) return;
      const u = new URL(url, location.href);
      const videoId = u.searchParams.get('v');
      if (!videoId) return;
      captured.set(videoId, {
        body,
        lang: u.searchParams.get('lang') ?? '',
        kind: u.searchParams.get('kind') ?? '',
        tlang: u.searchParams.get('tlang') ?? '',
      });
      while (captured.size > MAX_CAPTURED) captured.delete(captured.keys().next().value);
    } catch {}
  }

  (() => {
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try { this.__jevYtUrl = url; } catch {}
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        try {
          this.addEventListener('load', () => {
            try {
              if (
                this.status >= 200 && this.status < 300 &&
                typeof this.__jevYtUrl === 'string' && this.__jevYtUrl.includes('/api/timedtext')
              ) {
                captureIfTimedtext(this.__jevYtUrl, this.responseText);
              }
            } catch {}
          });
        } catch {}
        return origSend.apply(this, args);
      };
    } catch {}

    try {
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const result = origFetch.call(this, input, init);
        result.then((response) => {
          try {
            if (!response.ok) return;
            const url = typeof input === 'string' ? input : input?.url;
            if (typeof url !== 'string' || !url.includes('/api/timedtext')) return;
            response.clone().text().then((body) => captureIfTimedtext(url, body)).catch(() => {});
          } catch {}
        }).catch(() => {});
        return result;
      };
    } catch {}
  })();

  function candidates() {
    const out = [];
    try {
      const d = document.querySelector('ytd-page-manager')?.getCurrentData?.();
      if (d?.response) out.push(d.response);
    } catch {}
    try {
      const d = document.querySelector('ytd-watch-flexy')?.data;
      if (d) out.push(d);
    } catch {}
    if (window.ytInitialData) out.push(window.ytInitialData);
    return out;
  }

  function watchData(videoId) {
    return candidates().find((d) => d?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId) ?? null;
  }

  let captionsQueue = Promise.resolve();

  const handlers = {
    videoInfo({ videoId }) {
      const p = player();
      const vd = p?.getVideoData?.();
      if (!vd || vd.video_id !== videoId) return { ready: false };
      const data = watchData(videoId);
      if (!data) return { ready: false };
      const duration = Number(p.getPlayerResponse?.()?.videoDetails?.lengthSeconds) || p.getDuration?.() || 0;
      return { ready: true, duration, title: vd.title ?? '', dataJson: JSON.stringify(data) };
    },
    async captionsImpl({ videoId, timeoutMs = CAPTIONS_TIMEOUT_MS }) {
      const p = player();
      const vd = p?.getVideoData?.();
      if (!vd || vd.video_id !== videoId) return { status: 'wrong-video' };
      if (p.classList.contains('ad-showing')) return { status: 'ad' };

      const btn = document.querySelector('.ytp-subtitles-button');
      const wasOn = btn?.getAttribute('aria-pressed') === 'true';

      const pickEnglish = (list) => list.find((t) => isEnglishLang(t?.languageCode) && t.kind !== 'asr')
        ?? list.find((t) => isEnglishLang(t?.languageCode) && t.kind === 'asr');
      const englishBody = () => {
        const entry = captured.get(videoId);
        return capturedIsEnglish(entry) ? entry.body : null;
      };
      const stale = () => p.getVideoData?.()?.video_id !== videoId;

      if (wasOn) {
        // CC is already on: wait for the player's own download without touching the user's track.
        // If nothing arrives soon (paused video, slow start), toggle CC off and on to make the
        // player download again; CC ends up on, as the user had it.
        const start = Date.now();
        let kicked = false;
        for (;;) {
          const body = englishBody();
          if (body) return { status: 200, body };
          if (captured.has(videoId)) return { status: 'no-english' };
          if (stale()) return { status: 'wrong-video' };
          if (Date.now() - start >= timeoutMs) return { status: 'timeout' };
          if (!kicked && btn && Date.now() - start >= WAS_ON_KICK_MS) {
            kicked = true;
            btn.click();
            await sleep(POLL_MS);
            if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
          }
          await sleep(POLL_MS);
        }
      }

      // CC is off. A previously captured entry is only useful if it's already English.
      if (englishBody()) return { status: 200, body: englishBody() };

      let style;
      let pressed = false;
      try {
        style = document.createElement('style');
        style.id = 'jev-yt-hide-cc';
        style.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
        document.head.appendChild(style);
        // Turn captions on the way the user would; the hidden module call is only a fallback.
        if (btn) {
          btn.click();
          pressed = true;
        } else {
          p.loadModule('captions');
        }

        // Wait for the download. If nothing English has arrived after a moment, ask for an
        // English track explicitly (the default track may be another language, or none).
        const start = Date.now();
        let switched = false;
        while (Date.now() - start < timeoutMs) {
          const body = englishBody();
          if (body) return { status: 200, body };
          if (stale()) return { status: 'wrong-video' };
          if (!switched && (captured.has(videoId) || Date.now() - start >= TRACK_SWITCH_AFTER_MS)) {
            switched = true;
            const tracklist = p.getOption('captions', 'tracklist') ?? [];
            const track = tracklist.length ? pickEnglish(tracklist) : { languageCode: 'en' };
            if (!track) return { status: 'no-english' };
            p.setOption('captions', 'track', track);
          }
          await sleep(POLL_MS);
        }
        return { status: 'timeout' };
      } finally {
        try {
          if (pressed) {
            if (btn.getAttribute('aria-pressed') === 'true') btn.click(); // back off, as the user had it
          } else {
            p.unloadModule('captions');
          }
        } catch {}
        try {
          style?.remove();
        } catch {}
      }
    },
    // Serialize captions() calls so only one runs at a time: a stale call from a
    // superseded video navigation must finish (and restore player state in its
    // `finally`) before the next call touches loadModule/setOption, or the two can
    // stomp on each other's caption-module state.
    captions(payload) {
      const run = captionsQueue.then(() => handlers.captionsImpl(payload));
      captionsQueue = run.catch(() => {});
      return run;
    },
    async fetchTranscript({ params }) {
      const cfg = window.ytcfg;
      const res = await fetch('/youtubei/v1/get_transcript?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': String(cfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
          'X-Youtube-Client-Version': String(cfg?.get?.('INNERTUBE_CLIENT_VERSION') ?? ''),
        },
        body: JSON.stringify({ context: cfg?.get?.('INNERTUBE_CONTEXT'), params }),
      });
      return { status: res.status, body: await res.text() };
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== REQ) return;
    const { id, type, payload } = e.data;
    const handler = handlers[type];
    let result;
    let error;
    try {
      if (!handler) throw new Error(`unknown type ${type}`);
      result = await handler(payload ?? {});
    } catch (err) {
      error = String(err?.message ?? err);
    }
    window.postMessage({ source: RES, id, result, error }, '*');
  });
})();
