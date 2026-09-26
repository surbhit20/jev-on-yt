// Runs in the page's MAIN world. The only code that touches YouTube internals.
(() => {
  const REQ = 'jev-yt:req';
  const RES = 'jev-yt:res';

  const player = () => document.getElementById('movie_player');

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
