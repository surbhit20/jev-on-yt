# Evals: design

Status: design approved by the user (2026-09-27). Next step: implementation plan.
Supersedes `2026-09-26-evals-brainstorm-notes.md`.

## Goal
Measure how well Jev finds the right spots in a video, so changes to prompts, chunking and
`CONFIG` thresholds can be judged by numbers instead of by feel. Also measure voice-to-text
accuracy for the two voice modes (Instant = Chrome, Accurate = OpenAI).

## Decisions
- Ground truth comes from **both** chapters (volume) and ~10 hand-labelled questions (spots that
  appear more than once, absent topics).
- "Transcription accuracy" means **both** start/end correctness of spots and voice-to-text
  accuracy. Voice-to-text gets its own check (section 6).
- Chapters feed the start signal (`startsFromChapters`). Chapter cases would grade the pipeline
  against its own input, so they run with `chapters: []`. That forces the `start_` pass and also
  tests the no-chapter path.
- Go/show intent scoring is out of scope for now. It can be added later as a separate metric.

## 1. Shared search core: `src/search.js`
Move the pure part of `app.js:search()` into `src/search.js`:

```
runSearch({ chunks, windows, lines, chapters, query, highlightOnly, call, config })
  → { decision, jumpTime }
```

It runs `runQuery` plus the start signal (chapters or `runStart`), `mergeByChunk`, `decide`, and
the refine step for the top segment (the logic now in `refineTime`). `app.js` keeps the UI,
staleness checks, the cached start promise and intent, and calls `runSearch` for the rest.
The eval calls the same function, so it cannot drift from what the extension does.
Existing tests must stay green. Add unit tests for `runSearch` with a fake `call`.

*As built:* `src/search.js` holds only the pure steps (`startSignal`, `decideFromAnswers`,
`refineRange`, `jumpTimeFor`), which `app.js` uses between its UI updates. `runSearch` lives in
`src/pipeline.js`, next to the Jev calls, so the page-side app never loads Jev-calling code.
`runSearch` refines the top peak even for highlight decisions, so jump accuracy is always
measurable.

## 2. Test data: exported from the extension
YouTube captions are hard to fetch from Node, so the extension exports them.
- Dev-only (`CONFIG.dev`): a way to download the current video as
  `{ videoId, title, durationSec, lines, chapters }` JSON.
- Files go in `eval/data/videos/<videoId>.json` and are committed. Each video is exported once.

## 3. Test cases: `eval/cases/`
**Chapter cases (generated).** The runner builds one case per chapter:
query = chapter title, true spot = `[chapter.start, chapter.end]`.
- Skip generic titles (intro, outro, sponsor, q&a, conclusion, recap…) and chapters under 30 s.
- Run with `chapters: []`.
- Score start/end, jump and recall only. The topic may also come up outside its chapter, so
  peaks elsewhere are **not** counted as false.

**Hand-labelled cases (`eval/cases/labelled.json`, edited by the user, times in `mm:ss`):**
```json
[
  { "video": "abc123", "query": "how he trains for hills",
    "spots": [{ "start": "12:40", "end": "15:05" }, { "start": "41:10", "end": "42:30" }] },
  { "video": "abc123", "query": "sponsorship deals", "absent": true }
]
```
- Every spot for the topic must be marked, because peaks with no overlap count as false.
- Aim for ~10 across 3–4 videos, covering topics with several spots and absent topics.
- These run with the video's real chapters, like the extension does.

## 4. Metrics
Peaks = `decision.segments`. Peak start = `chunks[startIdx].start`, peak end = `chunks[to].end`.
Each true spot is paired one-to-one with the peak that overlaps it most. A spot with no
overlapping peak is missed.

| Metric | Per case | Aggregate |
|---|---|---|
| Start error | \|peak start − true start\| s, per paired spot | mean, p90 |
| End error | \|peak end − true end\| s, per paired spot | mean, p90 |
| Recall | paired spots / true spots | mean |
| False peaks | peaks overlapping no true spot (hand-labelled only) | mean per case |
| Jump accuracy | top peak's refined `jumpTime` is between true start − 30 s and + 60 s of the main (first) spot | % of cases |
| Jump rate | decision kind is `jump` (with `highlightOnly: false`) | % of cases |
| Absent pass | kind is `absent` (absent cases only) | % of cases |

Jump accuracy is scored on the top peak even when the decision is `highlight`, so threshold
changes don't hide location quality. Jump rate is reported next to it.

## 5. Runner: `npm run eval`
- Node, ESM, no new dependencies. Jev key from `JEV_API_KEY`, using `callJev` with the real
  endpoint and model from `CONFIG`.
- **Cache:** raw Jev responses are stored in `eval/cache/` (git-ignored), keyed by a hash of the
  request body. Threshold tuning re-scores without API calls. `--fresh` bypasses the cache.
- Filters: `--video <id>`, `--case <substring>`, `--only chapters|labelled|voice`.
- Output: a per-case table (query, kind, start/end error, recall, false peaks, jump ok) and an
  aggregate block for each case set. The full JSON report goes to
  `eval/results/<timestamp>.json`, and `--compare <file>` prints deltas against an earlier run.
- A case that errors (API failure) is reported as errored and left out of the aggregates.

## 6. Voice-to-text check
- **Script:** `eval/data/voice/script.json` lists the spoken queries (the ~10 labelled queries
  plus phrasing variants such as "where does he talk about…"), each with the intended text.
- **Accurate (OpenAI):** the user records each line once as `.webm` in `eval/data/voice/`. The
  runner sends them through `callTranscribe` (key from `OPENAI_API_KEY`). Repeatable.
- **Instant (Chrome):** Chrome's speech recognition only listens to a live mic and can't be fed
  files. Scored from a one-off live session instead: the user reads the script with the
  extension running, dev mode logs each result, and the user saves the log as
  `eval/data/voice/instant.json`.
- **Scores:** word error rate against the intended text (lowercased, punctuation stripped), and
  whether key terms survive (per-line `keyTerms` in the script).
- **End to end:** each transcription goes through `parseQuery` → `runSearch` for its labelled
  case. The runner reports whether the landing point changes compared with the typed query.
  That is the number that matters to a user.

## 7. LLM judge (added 2026-09-27)
The user asked for an LLM judge. Decisions: judge with **OpenAI** (a different model from Jev,
reusing the existing OpenAI key), and judge **all four** of: peak relevance, jump landing,
missed spots, and free-form unlabelled queries.
- `eval/judge.js`: chat completions with strict JSON schemas. Default model `gpt-4.1`
  (`JUDGE_MODEL` overrides it). Answers are cached like Jev responses. Opt-in with `--judge`.
- Peak: `discusses | passing | absent` for the lines under the peak; only `discusses` counts.
- Landing: `at_start | early | late | off_topic` for a window of −90 s to +120 s around the
  marked jump line, plus the line where the answer begins (landing error in seconds).
- Spots: ranges of chunk ids over the whole transcript. Judge spots with no overlapping peak are
  missed spots, and judged recall = judge spots with a peak / judge spots.
- `eval/cases/queries.json`: unlabelled `{ video, query }` cases, scored only by the judge.
- Judge metrics are reported next to the label-based ones, never mixed into them. On labelled cases
  the run reports agreement between the judge and the hand labels (per peak, jump, absent topic,
  and spot overlap both ways) and warns when any is under 80%.

## 8. Checking the eval itself (added 2026-09-27)
The user asked how to know the results are accurate. `eval/checks.js`, all opt-in or cheap:
- `--check` (no API): perfect answers must score perfectly; random-peak and whole-video floors;
  your labels vs `cases/relabel.json` (a blind relabelling), where the gap is the noise floor
  for start/end error.
- 95% bootstrap ranges on every aggregate number (1000 resamples, fixed seed).
- `--repeat n`: fresh Jev samples (cached under a per-repeat key); spread per metric = run-to-run noise.
- `--split tune|holdout|all`, default `tune`: a fixed ~70/30 split by hash of video + query.
- `--set key=value`: one-run numeric CONFIG overrides for tuning and "break it on purpose" checks.
- With `--judge`: every judge-vs-label disagreement listed with the judge's reason.
- README: a written labelling rule; target ~40 labelled queries.

## Layout
```
src/search.js                    shared search core (new)
eval/run.js                      entry point (npm run eval)
eval/cases.js                    load + generate cases
eval/metrics.js                  pairing and metrics (pure, unit-tested)
eval/wer.js                      word error rate (pure, unit-tested)
eval/judge.js                    LLM judge prompts, readers, agreement (unit-tested)
eval/checks.js                   baselines, ranges, split, noise, label consistency (unit-tested)
eval/data/videos/*.json          exported transcripts
eval/data/voice/                 script, recordings, instant log
eval/cases/labelled.json         hand labels
eval/cache/, eval/results/       git-ignored cache; results kept
```

## Build order
1. `src/search.js` extraction plus tests, with `app.js` switched over.
2. Dev transcript export.
3. `eval/metrics.js` and the runner with chapter cases.
4. Hand-labelled cases (after the user labels them).
5. Voice-to-text check.
