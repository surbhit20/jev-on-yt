(async () => {
  const load = (p) => import(chrome.runtime.getURL(p));
  const [{ makeBridge }, { getTranscript }, { parseChapters }, { formatTime }] = await Promise.all([
    load('src/bridge_client.js'),
    load('src/transcript.js'),
    load('src/transcript_parse.js'),
    load('src/time.js'),
  ]);

  const log = (...a) => console.log('[jev-yt]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = makeBridge();
  const video = { id: null, gen: 0, status: 'idle' };

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  async function waitForInfo(videoId, gen) {
    for (let i = 0; i < 30; i++) {
      if (gen !== video.gen) return null;
      const info = await bridge.call('videoInfo', { videoId }).catch(() => null);
      if (info?.ready) return info;
      await sleep(500);
    }
    return null;
  }

  async function prepare() {
    const videoId = currentVideoId();
    if (videoId === video.id) return;
    const gen = ++video.gen;
    Object.assign(video, { id: videoId, status: videoId ? 'preparing' : 'idle', lines: null, chapters: [], durationSec: 0 });
    if (!videoId) return;

    const t0 = performance.now();
    const info = await waitForInfo(videoId, gen);
    if (gen !== video.gen) return;
    if (!info) {
      video.status = 'unavailable';
      return log('no player data for', videoId);
    }
    const data = JSON.parse(info.dataJson);
    const chapters = parseChapters(data);
    const result = await getTranscript({ bridge, data, durationSec: info.duration, log });
    if (gen !== video.gen) return;
    if (!result) {
      video.status = 'unavailable';
      return log('No transcript for this video');
    }
    Object.assign(video, { status: 'ready', lines: result.lines, chapters, durationSec: info.duration });

    const fmt = (l) => `${formatTime(l.start)}–${formatTime(l.end)}  ${l.text}`;
    log(`${videoId} "${info.title}" via ${result.method}: ${result.lines.length} lines, ` +
      `${chapters.length} chapters, ${Math.round(performance.now() - t0)} ms`);
    log('first 5:\n' + result.lines.slice(0, 5).map(fmt).join('\n'));
    log('last 5:\n' + result.lines.slice(-5).map(fmt).join('\n'));
    if (chapters.length) log('chapters:\n' + chapters.map((c) => `${formatTime(c.start)} ${c.title}`).join('\n'));
  }

  globalThis.jev = { video };
  document.addEventListener('yt-navigate-finish', prepare);
  prepare();
})();
