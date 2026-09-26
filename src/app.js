import { CONFIG } from './config.js';
import { makeBridge } from './bridge_client.js';
import { getTranscript } from './transcript.js';
import { parseChapters } from './transcript_parse.js';
import { formatTime } from './time.js';
import * as chunker from './chunker.js';
import { parseQuery } from './query.js';
import * as scoring from './scoring.js';
import { segmentIndexForChunk } from './heat_layout.js';
import { createKeyWatcher } from './keys.js';
import { createVoice } from './voice.js';
import { createMediaGuard } from './media_guard.js';
import { createToast } from './ui/toast.js';
import { createHeatmap } from './ui/heatmap.js';
import { errorToast, spotsLabel, matchLabel } from './ui/messages.js';

const log = (...a) => console.log('[jev-yt]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''));

export function start() {
  const bridge = makeBridge();
  const toast = createToast();
  const heatmap = createHeatmap({ onCellClick, revealTickMs: CONFIG.revealTickMs });
  let listening = null; // toast handle while the mic is open
  const voice = createVoice({
    lang: CONFIG.voiceLang,
    onInterim: (text) => listening?.setBody(text || 'Listening…'),
  });

  const video = { id: null, gen: 0, status: 'idle' };
  let last = null; // last decision
  let cursor = -1; // index into last.segments for next/back
  let queued = null; // text asked while preparing
  let readyNotice = false; // the user waited on prep; tell them if it ends with no transcript
  let preparingShown = false; // "Getting things ready" is on screen from a Control hold
  let searchSeq = 0; // guards against out-of-order search() calls for the same video
  let searching = false;

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.ok) return res.result;
    const err = new Error(res?.error?.message ?? 'no response from background');
    err.status = res?.error?.status;
    throw err;
  }

  const videoEl = () => document.querySelector('#movie_player video') ?? document.querySelector('video');
  // Keeps the video's own audio out of the mic while the user talks.
  const media = createMediaGuard(videoEl, CONFIG.whileListening);
  const seek = (t) => { const v = videoEl(); if (v) v.currentTime = t; };
  const currentTime = () => videoEl()?.currentTime ?? 0;

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

  function startPass(videoId, chunks, windows, chapters) {
    if (chapters.length) {
      return Promise.resolve({
        ok: true, start: scoring.startsFromChapters(chunks, chapters, CONFIG.chapterStart, CONFIG.chapterOther),
      });
    }
    return send({ type: 'prepStart', videoId, windows })
      .then((r) => ({ ok: true, start: scoring.mergeByChunk(chunks.length, [r.start]) }))
      .catch((e) => {
        log('start pass failed:', e.message);
        return { ok: false, start: chunks.map(() => 0) };
      });
  }

  function markUnavailable(why) {
    video.status = 'unavailable';
    log(why);
    if (queued || readyNotice) {
      queued = null;
      readyNotice = false;
      preparingShown = false;
      toast.show({ title: 'No transcript for this video', dismissMs: CONFIG.toastMs.info });
    }
  }

  async function prepare(retry = false) {
    const videoId = currentVideoId();
    if (videoId === video.id && !retry) return;
    if (videoId !== video.id) {
      heatmap.clear();
      toast.hide();
      last = null;
      cursor = -1;
      queued = null;
      readyNotice = false;
      preparingShown = false;
      voice.abort();
      media.reset();
      listening = null;
    }
    const gen = ++video.gen;
    Object.assign(video, {
      id: videoId, status: videoId ? 'preparing' : 'idle',
      lines: null, chapters: [], chunks: null, windows: null, startPromise: null, durationSec: 0,
    });
    if (!videoId) return;

    const t0 = performance.now();
    const info = await waitForInfo(videoId, gen);
    if (gen !== video.gen) return;
    if (!info) return markUnavailable(`no player data for ${videoId}`);
    let data;
    try {
      data = JSON.parse(info.dataJson);
    } catch {
      return markUnavailable('bad player data');
    }
    const chapters = parseChapters(data);
    const result = await getTranscript({
      bridge, videoId, data, durationSec: info.duration, log, isStale: () => gen !== video.gen,
    });
    if (gen !== video.gen) return;
    if (!result) return markUnavailable('No transcript for this video');

    const durationSec = Math.max(info.duration || 0, result.lines.at(-1)?.end || 0);
    const chunkSec = chunker.chunkSecondsFor(durationSec, CONFIG.chunkRules);
    const chunks = chunker.buildChunks(result.lines, chunkSec, CONFIG.sentenceSlack);
    const windows = chunker.buildWindows(chunks, CONFIG.windowSize, CONFIG.windowOverlap);
    Object.assign(video, {
      status: 'ready', lines: result.lines, chapters, chunks, windows, durationSec,
      startPromise: startPass(videoId, chunks, windows, chapters),
    });
    log(`${videoId} "${info.title}" ready via ${result.method} in ${Math.round(performance.now() - t0)} ms: ` +
      `${result.lines.length} lines → ${chunks.length} chunks of ~${chunkSec}s → ${windows.length} windows; ` +
      `${chapters.length ? `${chapters.length} chapters` : 'no chapters, start pass running'}`);

    if (readyNotice) {
      readyNotice = false;
      if (preparingShown) toast.hide(); // prep finished while the wait toast was up
      preparingShown = false;
    }
    if (queued) {
      const text = queued;
      queued = null;
      submit(text);
    }
  }

  // Control while preparing: no mic, just a clear wait state that updates itself when prep ends.
  function showPreparing(dismissMs = 0) {
    readyNotice = true;
    preparingShown = true;
    toast.show({
      loading: true, title: 'Getting things ready', dismissMs,
    });
    if (video.status === 'unavailable') prepare(true).catch((e) => log('prepare failed:', e.message));
  }

  function showError(err) {
    log(`error (${err?.status ?? '?'}): ${err?.message}`);
    const m = errorToast(err);
    toast.show({
      title: m.title,
      actions: m.settings
        ? [{ label: 'Open settings', primary: true, onClick: () => send({ type: 'openOptions' }).catch(() => {}) }]
        : [],
    });
  }

  function showAll() {
    const n = last?.segments?.length ?? 0;
    if (!n || last.kind === 'absent') return;
    heatmap.reveal(CONFIG.revealMs);
    toast.show({
      title: `Found ${spotsLabel(n)}`,
      body: 'Say "next" or press →, or click a highlight.',
      dismissMs: CONFIG.toastMs.highlight,
    });
  }

  function goToSegment(i) {
    const segs = last.segments;
    cursor = i;
    const s = segs[i];
    seek(s.time);
    heatmap.pulse(s.from, s.to, CONFIG.pulseMs);
    heatmap.reveal(CONFIG.revealMs);
    toast.show({ title: matchLabel(i, segs.length, s.time), dismissMs: CONFIG.toastMs.info });
  }

  function cycle(dir) {
    const segs = last && last.kind !== 'absent' ? last.segments : [];
    if (!segs.length) {
      toast.show({ title: 'No matches yet', body: 'Ask something first.', dismissMs: CONFIG.toastMs.info });
      return false;
    }
    const n = segs.length;
    goToSegment(cursor < 0 ? (dir > 0 ? 0 : n - 1) : (cursor + dir + n) % n);
    return true;
  }

  function onCellClick(idx) {
    if (!last || !video.chunks?.[idx]) return;
    const i = segmentIndexForChunk(last.segments, idx);
    if (i >= 0) return goToSegment(i);
    seek(Math.max(0, video.chunks[idx].start - CONFIG.seekPadSec));
  }

  function undo(prev) {
    seek(prev);
    toast.show({ title: `Back to ${formatTime(prev)}`, dismissMs: CONFIG.toastMs.info });
  }

  async function refineTime(d, query, gen) {
    const { chunks, lines } = video;
    let time = d.target.time;
    const s = d.target.startIdx;
    const e = Math.min(Math.max(d.target.from, s + 1), chunks.length - 1);
    const from = chunks[s].lineIdx[0];
    const to = chunks[e].lineIdx[1];
    try {
      const { lineIdx } = await send({ type: 'refine', lines: lines.slice(from, to + 1), offset: from, query });
      if (gen === video.gen && lineIdx != null && lines[lineIdx]) {
        time = Math.max(0, lines[lineIdx].start - CONFIG.refinePadSec);
        log(`refine → line ${lineIdx}: "${lines[lineIdx].text}"`);
      }
    } catch (err) {
      log('refine failed:', err.message);
    }
    return time;
  }

  async function search(parsed) {
    const seq = ++searchSeq;
    searching = true;
    try {
      const { id: videoId, gen, chunks, windows, durationSec } = video;
      const t0 = performance.now();
      const stale = () => gen !== video.gen || seq !== searchSeq;
      toast.show({ title: `Searching "${parsed.query}"…` });
      heatmap.shimmer(true);

      let d;
      try {
        const res = await send({ type: 'query', videoId, windows, query: parsed.query });
        if (stale()) return;
        let st = await video.startPromise;
        if (!st.ok && !stale()) {
          video.startPromise = startPass(videoId, chunks, windows, video.chapters);
          st = await video.startPromise;
        }
        if (stale()) return;
        const rel = scoring.mergeByChunk(chunks.length, res.perWindow.map((w) => w?.rel));
        d = scoring.decide({
          chunks, rel, start: st.start,
          bests: res.perWindow.map((w) => (w?.best ? chunker.chunkIndex(w.best) : null)),
          exists: res.perWindow.map((w) => w?.exists ?? null),
          unknown: rel.map((v) => v == null),
          highlightOnly: parsed.highlightOnly,
          config: CONFIG,
        });
        log(`"${parsed.query}": ${d.kind}, ${d.segments.length} segments, maxExists=${d.maxExists.toFixed(2)}, ` +
          `failedWindows=${JSON.stringify(res.failed)}, cached=${res.cached}`);
      } catch (err) {
        if (stale()) return;
        heatmap.shimmer(false);
        return showError(err);
      }

      heatmap.shimmer(false);
      last = d;
      cursor = -1;

      if (d.kind === 'absent') {
        heatmap.clear();
        toast.show({
          title: 'Not discussed in this video',
          body: `Nothing about "${parsed.query}".`, dismissMs: CONFIG.toastMs.absent,
        });
      } else {
        heatmap.render({ chunks, heat: d.heat, durationSec, floor: CONFIG.heatFloor, wave: CONFIG.wave });
        if (d.kind === 'jump') {
          const time = await refineTime(d, parsed.query, gen);
          if (stale()) return;
          const prev = currentTime();
          seek(time);
          cursor = 0;
          heatmap.pulse(d.target.from, d.target.to, CONFIG.pulseMs);
          heatmap.reveal(CONFIG.revealMs);
          toast.show({
            title: `Jumped to ${formatTime(time)}`,
            body: d.segments.length > 1 ? `${spotsLabel(d.segments.length)} found · → for the next one` : '',
            actions: [
              { label: 'Undo', onClick: () => undo(prev) },
              { label: 'Show all', primary: true, onClick: showAll },
            ],
            dismissMs: CONFIG.toastMs.jump,
          });
        } else {
          showAll();
        }
      }
      log(`total ${Math.round(performance.now() - t0)} ms`);
      return d;
    } finally {
      if (seq === searchSeq) searching = false;
    }
  }

  async function submit(text) {
    const parsed = parseQuery(text);
    if (parsed.kind === 'empty') {
      toast.show({
        title: "Didn't catch that",
        body: 'Hold Control and ask again, or double-tap it to type.', dismissMs: CONFIG.toastMs.info,
      });
      return;
    }
    if (parsed.kind === 'next') return cycle(1);
    if (parsed.kind === 'back') return cycle(-1);
    if (!video.id) return;
    if (video.status === 'preparing' || video.status === 'unavailable') {
      queued = text;
      toast.show({ title: 'Getting things ready…', body: `I'll search "${parsed.query}" when it's ready.` });
      if (video.status === 'unavailable') prepare(true).catch((e) => log('prepare failed:', e.message));
      return;
    }
    return search(parsed);
  }

  const keys = createKeyWatcher({
    holdMs: CONFIG.holdMs,
    doubleTapMs: CONFIG.doubleTapMs,
    triggerCodes: CONFIG.triggerCodes,
    isEditable,
    on: {
      holdStart() {
        if (!video.id) return;
        if (video.status !== 'ready') return showPreparing();
        if (!voice.supported) {
          toast.show({
            title: "Voice isn't available here",
            body: 'Double-tap Control to type instead.', dismissMs: CONFIG.toastMs.info,
          });
          return;
        }
        try {
          voice.start();
          media.engage();
        } catch (err) {
          log('voice failed to start:', err.message);
          return;
        }
        // Fall back to a no-op handle so holdEnd still stops the mic if the toast can't render.
        listening = toast.show({ title: 'Listening…', body: 'Release Control when done.' })
          ?? { setTitle() {}, setBody() {} };
      },
      async holdEnd() {
        if (preparingShown) {
          preparingShown = false;
          toast.hide(); // released during prep: slide the wait toast away
        }
        if (!listening) return;
        listening = null;
        const { text, error } = await voice.stop();
        if (error === 'aborted') return; // a newer hold owns the mic (and the paused video)
        media.release();
        if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
          toast.show({ title: 'Mic blocked', body: 'Double-tap Control to type instead.' });
          return;
        }
        if (error && error !== 'no-speech' && !text) {
          toast.show({
            title: "Voice didn't work",
            body: 'Double-tap Control to type instead.', dismissMs: CONFIG.toastMs.info,
          });
          return;
        }
        submit(text);
      },
      holdCancel() {
        voice.abort();
        media.release();
        if (listening) {
          listening = null;
          toast.hide();
        }
      },
      doubleTap() {
        if (!video.id) return;
        if (video.status !== 'ready') {
          showPreparing(CONFIG.toastMs.info);
          preparingShown = false; // no hold to release; it dismisses itself
          return;
        }
        toast.show({
          title: 'Ask this video',
          input: { placeholder: 'e.g. caffeine and sleep', onSubmit: (t) => submit(t) },
        });
      },
      escape() {
        if (toast.isOpen()) {
          toast.hide();
          return true;
        }
        if (heatmap.hasCells()) {
          heatmap.clear();
          last = null;
          cursor = -1;
          return true;
        }
        return false;
      },
      arrow(dir) {
        if (!toast.isOpen() || !last?.segments?.length || last.kind === 'absent') return false;
        if (searching || video.status !== 'ready') return false;
        return cycle(dir);
      },
    },
  });

  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  window.addEventListener('keydown', (e) => { if (keys.keydown(e)) swallow(e); }, true);
  window.addEventListener('keyup', (e) => { if (keys.keyup(e)) swallow(e); }, true);
  window.addEventListener('mousedown', () => keys.mousedown(), true);
  window.addEventListener('blur', () => keys.blur());
  document.addEventListener('yt-navigate-finish', () => prepare().catch((e) => log('prepare failed:', e.message)));

  globalThis.jev = { ask: submit, video, get last() { return last; } };
  prepare().catch((e) => log('prepare failed:', e.message));
}
