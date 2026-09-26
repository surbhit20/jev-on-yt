// Every tunable lives here. Nothing else hardcodes thresholds.
export const CONFIG = {
  model: 'jev-latest',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  dev: true,

  // Chunking
  chunkRules: [
    { maxDurationSec: 20 * 60, chunkSec: 15 },
    { maxDurationSec: 2 * 60 * 60, chunkSec: 30 },
    { maxDurationSec: Infinity, chunkSec: 45 },
  ],
  sentenceSlack: 0.4,
  windowSize: 30,
  windowOverlap: 1,

  // Requests
  concurrency: 10,
  retryTries: 4,
  retryBaseMs: 500,
  maxRefineLines: 255,

  // Scoring
  kernel: [0.25, 0.5, 0.25],
  relT: 0.5,
  gapChunks: 1,
  bestBoost: 1.2,
  absentT: 0.35,
  foundT: 0.7,
  margin: 1.5,
  walkBackChunks: 3,
  startT: 0.5,
  chapterStart: 1,
  chapterOther: 0.3,
  seekPadSec: 3,
  refinePadSec: 1.5,

  // UI
  revealMs: 5000,
  revealTickMs: 800,
  heatFloor: 0.2, // click targets on the progress bar
  wave: {
    heightPx: 48,
    color: '#a3e635', // lime
    fillOpacity: 0.58,
    edgeOpacity: 1,
    smoothRadius: 3, // chunks
    floor: 0.04, // below this smoothed heat the wave is flat
    peakCut: 0.35, // peaks only: below 35% of the video's peak stays flat
  },
  pulseMs: 1500,
  toastMs: { jump: 4000, highlight: 6000, absent: 4000, info: 3000 },
  triggerCodes: ['ControlLeft', 'ControlRight'], // hold to talk, double-tap to type
  holdMs: 250,
  doubleTapMs: 350,
  voiceLang: 'en-US',

  // Transcript
  adWaitMs: 1000,
  adWaitTries: 180,
};
