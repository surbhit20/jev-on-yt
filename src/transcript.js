import { CONFIG } from './config.js';
import { findTranscriptParams, parseTranscriptResponse, parseJson3, linesFromPanel } from './transcript_parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

// Player captions, waiting out a pre-roll ad first. Returns lines or null.
async function tryCaptions({ bridge, videoId, log, isStale }) {
  try {
    let loggedAdWait = false;
    for (let attempt = 0; attempt <= CONFIG.adWaitTries; attempt++) {
      if (isStale()) return null;
      const res = await bridge.call('captions', { videoId });
      if (res.status === 200) {
        const lines = parseJson3(JSON.parse(res.body));
        if (lines.length) return lines;
        log('captions returned 0 lines');
        return null;
      }
      if (res.status === 'ad') {
        if (!loggedAdWait) {
          log('waiting for ad to finish');
          loggedAdWait = true;
        }
        if (attempt < CONFIG.adWaitTries) await sleep(CONFIG.adWaitMs);
        continue;
      }
      log(`captions status ${res.status}`);
      return null;
    }
  } catch (e) {
    log(`captions failed: ${e.message}`);
  }
  return null;
}

// The only transcript entry point. Other sites can add their own implementation later.
// Player captions are retried a few times (the first try at page load is the least reliable)
// before the slower fallbacks: YouTube's transcript API, then the visible transcript panel.
export async function getTranscript({ bridge, videoId, data, durationSec, log = () => {}, isStale = () => false }) {
  for (let attempt = 1; attempt <= CONFIG.transcriptAttempts; attempt++) {
    const lines = await tryCaptions({ bridge, videoId, log, isStale });
    if (lines) return { lines, method: attempt === 1 ? 'captions' : `captions (attempt ${attempt})` };
    if (isStale()) return null;
    if (attempt < CONFIG.transcriptAttempts) {
      log(`captions attempt ${attempt} failed, retrying in ${CONFIG.transcriptRetryMs} ms`);
      await sleep(CONFIG.transcriptRetryMs);
    }
  }
  if (isStale()) return null;

  const params = findTranscriptParams(data);
  if (params) {
    try {
      const res = await bridge.call('fetchTranscript', { params });
      if (res.status === 200) {
        const lines = parseTranscriptResponse(JSON.parse(res.body));
        if (lines.length) return { lines, method: 'api' };
        log('transcript api returned 0 lines');
      } else {
        log(`transcript api status ${res.status}: ${res.body.slice(0, 200)}`);
      }
    } catch (e) {
      log(`transcript api failed: ${e.message}`);
    }
  } else {
    log('no transcript params in page data');
  }

  try {
    const lines = await scrapePanel(durationSec);
    if (lines.length) return { lines, method: 'panel' };
    log('transcript panel had 0 lines');
  } catch (e) {
    log(`transcript panel failed: ${e.message}`);
  }
  return null;
}

async function scrapePanel(durationSec) {
  const wasOpen = document.querySelector(PANEL)?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  if (!wasOpen) {
    const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) throw new Error('no "Show transcript" button');
    btn.click();
  }
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    await sleep(200);
    rows = [...document.querySelectorAll(`${PANEL} ytd-transcript-segment-renderer`)].map((s) => ({
      ts: s.querySelector('.segment-timestamp')?.textContent ?? '',
      text: s.querySelector('.segment-text')?.textContent ?? '',
    }));
  }
  if (!wasOpen) document.querySelector(PANEL)?.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  return linesFromPanel(rows, durationSec);
}
