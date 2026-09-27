# Evals

Runs the extension's own search (`runSearch` in `src/pipeline.js`) against the real Jev API on
exported transcripts, and scores where the peaks and jumps land. Design:
`docs/superpowers/specs/2026-09-27-evals-design.md`.

```
JEV_API_KEY=… npm run eval                      # everything
npm run eval -- --only chapters|labelled|voice
npm run eval -- --video <id> --case <text>      # filter
npm run eval -- --offline                       # cached responses only, no API calls
npm run eval -- --fresh                         # ignore the cache
npm run eval -- --compare eval/results/<run>.json   # deltas against an earlier run
```

Jev responses are cached in `eval/cache/` (git-ignored), keyed by the exact request. After changing
a scoring threshold in `src/config.js`, `--offline` re-scores for free. Changes to chunking or
prompts change the requests, so those need API calls. Every run is saved in `eval/results/`.

## 1. Export videos
Load the unpacked extension with `CONFIG.dev: true`, open a video and wait until it's ready. Then
open the toolbar popup and use **Dev · evals → Export transcript**. Move the downloaded
`<videoId>.json` into `eval/data/videos/`.

Each video with chapters becomes one case per topical chapter automatically: title = query, the
chapter = the true spot. Generic titles (intro, outro, sponsor…) and chapters under 30 s are
skipped. These cases run with chapters hidden, because chapters feed the start signal.

## 2. Hand-label cases
Copy `cases/labelled.example.json` to `cases/labelled.json`. Mark **every** place the topic comes
up (`mm:ss` or `h:mm:ss`), because peaks outside the marked spots count as false. Use
`"absent": true` for topics that aren't in the video. The first spot is the one a jump should land on.

## 3. Voice-to-text
Copy `data/voice/script.example.json` to `data/voice/script.json`. `case` (optional) is the `query`
of a labelled case, so the runner can check whether the transcription still lands on the same spot.
- **Accurate (OpenAI):** record each line as `data/voice/<id>.webm` (or .m4a/.mp3/.wav) and set
  `OPENAI_API_KEY`.
- **Instant (Chrome):** with Instant on, hold Control and read the script lines in order on one
  tab. Then use **Dev · evals → Export voice log** and save it as `data/voice/instant.json`.
  The lines are matched by order, so don't retake any.

## Metrics
| | |
|---|---|
| start / end error | seconds between each true spot and its paired peak (mean, p90) |
| recall | true spots that got a peak |
| false peaks | peaks touching no true spot (hand-labelled cases only) |
| jump acc | refined jump for the top peak lands 30 s before to 60 s after the first spot's start |
| jump rate | how often the decision is a jump rather than a highlight |
| absent pass | absent topics that come back "not discussed" |
| voice | word error rate, key terms kept, same spot as the typed query (within 15 s) |
