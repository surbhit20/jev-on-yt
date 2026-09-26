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

  // Transcript
  adWaitMs: 1000,
  adWaitTries: 180,
};
