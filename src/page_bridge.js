// Runs in the page's MAIN world. The only code that touches YouTube internals.
(() => {
  const REQ = 'jev-yt:req';
  const RES = 'jev-yt:res';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');

  // Mirror config.js-style tunables: this is a classic MAIN-world script and can't import
  // src/config.js (module-only), so these timing constants live here instead.
  const CAPTIONS_TIMEOUT_MS = 5000;
  const TRACKLIST_POLL_TRIES = 10;
  const POLL_MS = 100;
  const MAX_CAPTURED = 5;

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

      if (wasOn) {
        // CC is already on: just poll for what the player captures, without touching
        // the user's chosen track.
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (captured.has(videoId)) {
            const entry = captured.get(videoId);
            return capturedIsEnglish(entry) ? { status: 200, body: entry.body } : { status: 'no-english' };
          }
          if (p.getVideoData?.()?.video_id !== videoId) return { status: 'wrong-video' };
          if (Date.now() >= deadline) return { status: 'timeout' };
          await sleep(POLL_MS);
        }
      }

      // CC is off. A previously captured entry is only useful if it's already English;
      // otherwise fall through and force the English track.
      if (captured.has(videoId) && capturedIsEnglish(captured.get(videoId))) {
        return { status: 200, body: captured.get(videoId).body };
      }

      let style;
      try {
        style = document.createElement('style');
        style.id = 'jev-yt-hide-cc';
        style.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
        document.head.appendChild(style);
        p.loadModule('captions');

        let tracklist = [];
        for (let i = 0; i < TRACKLIST_POLL_TRIES; i++) {
          if (p.getVideoData?.()?.video_id !== videoId) return { status: 'wrong-video' };
          tracklist = p.getOption('captions', 'tracklist') ?? [];
          if (tracklist.length) break;
          await sleep(POLL_MS);
        }

        let track;
        if (!tracklist.length) {
          track = { languageCode: 'en' };
        } else {
          track = tracklist.find((t) => isEnglishLang(t?.languageCode) && t.kind !== 'asr')
            ?? tracklist.find((t) => isEnglishLang(t?.languageCode) && t.kind === 'asr');
          if (!track) return { status: 'no-english' };
        }

        p.setOption('captions', 'track', track);

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (captured.has(videoId) && capturedIsEnglish(captured.get(videoId))) {
            return { status: 200, body: captured.get(videoId).body };
          }
          if (p.getVideoData?.()?.video_id !== videoId) return { status: 'wrong-video' };
          await sleep(POLL_MS);
        }
        return { status: 'timeout' };
      } finally {
        try {
          p.unloadModule('captions');
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
