(async () => {
  const load = (p) => import(chrome.runtime.getURL(p));
  const [
    { CONFIG }, { makeBridge }, { getTranscript }, { parseChapters }, { formatTime },
    chunker, { parseQuery }, scoring,
  ] = await Promise.all([
    load('src/config.js'), load('src/bridge_client.js'), load('src/transcript.js'),
    load('src/transcript_parse.js'), load('src/time.js'), load('src/chunker.js'),
    load('src/query.js'), load('src/scoring.js'),
  ]);

  const log = (...a) => console.log('[jev-yt]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = makeBridge();
  const video = { id: null, gen: 0, status: 'idle' };
  let last = null;
  let cursor = 0;

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.ok) return res.result;
    const err = new Error(res?.error?.message ?? 'no response from background');
    err.status = res?.error?.status;
    throw err;
  }

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
    last = null;
    Object.assign(video, {
      id: videoId, status: videoId ? 'preparing' : 'idle',
      lines: null, chapters: [], chunks: null, windows: null, startPromise: null, durationSec: 0,
    });
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
    const result = await getTranscript({
      bridge, videoId, data, durationSec: info.duration, log, isStale: () => gen !== video.gen,
    });
    if (gen !== video.gen) return;
    if (!result) {
      video.status = 'unavailable';
      return log('No transcript for this video');
    }

    const chunkSec = chunker.chunkSecondsFor(info.duration, CONFIG.chunkRules);
    const chunks = chunker.buildChunks(result.lines, chunkSec, CONFIG.sentenceSlack);
    const windows = chunker.buildWindows(chunks, CONFIG.windowSize, CONFIG.windowOverlap);
    const startPromise = chapters.length
      ? Promise.resolve(scoring.startsFromChapters(chunks, chapters, CONFIG.chapterStart, CONFIG.chapterOther))
      : send({ type: 'prepStart', videoId, windows })
        .then((r) => scoring.mergeByChunk(chunks.length, [r.start]))
        .catch((e) => {
          log('start pass failed:', e.message);
          return chunks.map(() => 0);
        });

    Object.assign(video, {
      status: 'ready', lines: result.lines, chapters, chunks, windows, startPromise, durationSec: info.duration,
    });
    log(`${videoId} "${info.title}" ready via ${result.method} in ${Math.round(performance.now() - t0)} ms: ` +
      `${result.lines.length} lines → ${chunks.length} chunks of ~${chunkSec}s → ${windows.length} windows; ` +
      `${chapters.length ? `${chapters.length} chapters` : 'no chapters, start pass running'}`);
  }

  function seek(t) {
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  }

  function cycle(dir) {
    const segs = last?.segments ?? [];
    if (!segs.length) return log('no matches to cycle');
    cursor = (cursor + dir + segs.length) % segs.length;
    seek(segs[cursor].time);
    log(`match ${cursor + 1}/${segs.length} → ${formatTime(segs[cursor].time)}`);
  }

  async function ask(text) {
    const parsed = parseQuery(text);
    if (parsed.kind === 'empty') return log('empty query');
    if (parsed.kind === 'next') return cycle(1);
    if (parsed.kind === 'back') return cycle(-1);
    if (video.status !== 'ready') return log(`not ready (${video.status})`);

    const { id: videoId, gen, chunks, windows, lines } = video;
    const t0 = performance.now();
    log(`searching "${parsed.query}"${parsed.highlightOnly ? ' (highlight only)' : ''}…`);
    const res = await send({ type: 'query', videoId, windows, query: parsed.query });
    if (gen !== video.gen) return;

    const rel = scoring.mergeByChunk(chunks.length, res.perWindow.map((w) => w?.rel));
    const exists = res.perWindow.map((w) => w?.exists ?? null);
    const bests = res.perWindow.map((w) => (w?.best ? chunker.chunkIndex(w.best) : null));
    const unknown = rel.map((v) => v == null);
    const start = await video.startPromise;
    const d = scoring.decide({
      chunks, rel, start, bests, exists, unknown, highlightOnly: parsed.highlightOnly, config: CONFIG,
    });
    last = d;
    cursor = 0;

    console.table(d.segments.slice(0, 8).map((s) => ({
      from: formatTime(chunks[s.from].start), to: formatTime(chunks[s.to].end),
      score: +s.score.toFixed(2), seek: formatTime(s.time),
    })));
    log(`maxExists=${d.maxExists.toFixed(2)} failedWindows=${JSON.stringify(res.failed)} cached=${res.cached}`);

    if (d.kind === 'jump') {
      let time = d.target.time;
      const s = d.target.startIdx;
      const e = Math.min(Math.max(d.target.from, s + 1), chunks.length - 1);
      const from = chunks[s].lineIdx[0];
      const to = chunks[e].lineIdx[1];
      try {
        const { lineIdx } = await send({ type: 'refine', lines: lines.slice(from, to + 1), offset: from, query: parsed.query });
        if (lineIdx != null && lines[lineIdx]) time = Math.max(0, lines[lineIdx].start - CONFIG.refinePadSec);
        log(`refine → ${lineIdx != null ? `line ${lineIdx}: "${lines[lineIdx]?.text}"` : 'none, using chunk start'}`);
      } catch (err) {
        log('refine failed:', err.message);
      }
      if (gen !== video.gen) return;
      seek(time);
      log(`JUMP → ${formatTime(time)}`);
    } else if (d.kind === 'highlight') {
      log(`HIGHLIGHT: found ${d.segments.length} spots; jev.ask("next") to cycle`);
    } else {
      log('ABSENT: Not discussed in this video');
    }
    log(`total ${Math.round(performance.now() - t0)} ms`);
    return d;
  }

  globalThis.jev = {
    ask: (text) => ask(text).catch((e) => log(`error (${e.status ?? '?'}): ${e.message}`)),
    video,
    get last() { return last; },
  };
  document.addEventListener('yt-navigate-finish', prepare);
  prepare();
})();
