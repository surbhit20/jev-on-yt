// Runs in the page's MAIN world. The only code that touches YouTube internals.
(() => {
  const REQ = 'jev-yt:req';
  const RES = 'jev-yt:res';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');

  // Capture the player's own /api/timedtext response, keyed by video id.
  const captured = new Map();
  function captureIfTimedtext(url, body) {
    try {
      if (typeof url !== 'string' || !url.includes('/api/timedtext')) return;
      const videoId = new URL(url, location.href).searchParams.get('v');
      if (!videoId) return;
      captured.set(videoId, body);
      while (captured.size > 5) captured.delete(captured.keys().next().value);
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
              if (this.status >= 200 && this.status < 300) captureIfTimedtext(this.__jevYtUrl, this.responseText);
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

  const handlers = {
    videoInfo({ videoId }) {
      const p = player();
      const vd = p?.getVideoData?.();
      if (!vd || vd.video_id !== videoId) return { ready: false };
      const data = watchData(videoId);
      if (!data) return { ready: false };
      return { ready: true, duration: p.getDuration?.() ?? 0, title: vd.title ?? '', dataJson: JSON.stringify(data) };
    },
    async captions({ videoId, timeoutMs = 5000 }) {
      if (captured.has(videoId)) return { status: 200, body: captured.get(videoId) };

      const p = player();
      const vd = p?.getVideoData?.();
      if (!vd || vd.video_id !== videoId) return { status: 'wrong-video' };
      if (p.classList.contains('ad-showing')) return { status: 'ad' };

      const btn = document.querySelector('.ytp-subtitles-button');
      const wasOn = btn?.getAttribute('aria-pressed') === 'true';
      let style;
      try {
        if (!wasOn) {
          style = document.createElement('style');
          style.id = 'jev-yt-hide-cc';
          style.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
          document.head.appendChild(style);
          p.loadModule('captions');
        }

        const isEnglish = (t) => t?.languageCode === 'en' || String(t?.languageCode ?? '').startsWith('en-');
        let tracklist = [];
        for (let i = 0; i < 10; i++) {
          tracklist = p.getOption('captions', 'tracklist') ?? [];
          if (tracklist.length) break;
          await sleep(100);
        }

        let track;
        if (!tracklist.length) {
          track = { languageCode: 'en' };
        } else {
          track = tracklist.find((t) => isEnglish(t) && t.kind !== 'asr')
            ?? tracklist.find((t) => isEnglish(t) && t.kind === 'asr');
          if (!track) return { status: 'no-english' };
        }

        p.setOption('captions', 'track', track);

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (captured.has(videoId)) return { status: 200, body: captured.get(videoId) };
          await sleep(100);
        }
        return { status: 'timeout' };
      } finally {
        try {
          if (!wasOn) p.unloadModule('captions');
        } catch {}
        try {
          style?.remove();
        } catch {}
      }
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
