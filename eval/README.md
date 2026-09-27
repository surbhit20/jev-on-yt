# Evals

Runs the extension's own search (`runSearch` in `src/pipeline.js`) against the real Jev API on
exported transcripts, and scores where the peaks and jumps land. Design:
`docs/superpowers/specs/2026-09-27-evals-design.md`.

```
npm run eval -- --check                         # no API: are the metrics and your labels sound?
JEV_API_KEY=… npm run eval                      # tune set (70% of cases)
npm run eval -- --split holdout                 # the 30% held back, once, at the end
npm run eval -- --repeat 3                      # measure run-to-run noise
npm run eval -- --set relT=0.6                  # try a threshold without editing config.js
npm run eval -- --judge                         # add the LLM judge (OpenAI, needs OPENAI_API_KEY)
npm run eval -- --only chapters|labelled|queries|voice
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
Copy `cases/labelled.example.json` to `cases/labelled.json`. Aim for **~40 queries**: with 10,
"70% jump accuracy" could really be anywhere from about 40% to 90%. Mix topics that come up once,
topics that come up several times, topics that aren't in the video, and vague vs specific wording.

**Labelling rule.** Follow it every time:
- **Label before looking at Jev's peaks.** Seeing its answer first pulls your labels toward it.
- **Start** = the first sentence that actually discusses the topic. A teaser ("later I'll get to…")
  doesn't count, and neither does the lead-in.
- **End** = the last sentence on the topic, before they move on. Short asides (under ~30 s) that
  come back to the topic stay inside one spot.
- A mention **under ~15 s**, or only in passing, is not a spot.
- Mark **every** spot. Peaks outside your spots count as false.
- The **first spot** is where a jump should land. Put the main answer first if it isn't the earliest.
- `"absent": true` for topics the video never discusses.
- Times as `mm:ss` or `h:mm:ss`.

## 3. Voice-to-text
Copy `data/voice/script.example.json` to `data/voice/script.json`. `case` (optional) is the `query`
of a labelled case, so the runner can check whether the transcription still lands on the same spot.
- **Accurate (OpenAI):** record each line as `data/voice/<id>.webm` (or .m4a/.mp3/.wav) and set
  `OPENAI_API_KEY`.
- **Instant (Chrome):** with Instant on, hold Control and read the script lines in order on one
  tab. Then use **Dev · evals → Export voice log** and save it as `data/voice/instant.json`.
  The lines are matched by order, so don't retake any.

## 4. LLM judge (`--judge`)
An OpenAI model (default `gpt-4.1`, override with `JUDGE_MODEL`) grades every search result
against the transcript, so it needs no labels:
- **Peaks:** does the transcript under each peak substantively discuss the query? This gives
  precision and false peaks on every case, chapters included.
- **Landing:** with the jump point marked, is it `at_start`, `early`, `late` or `off_topic`?
  It also gives the line where the answer begins, which becomes the landing error in seconds.
- **Spots:** reads the whole transcript and lists every stretch on the query. Any it lists that
  have no peak are **missed spots**, with their times printed.
- **Free-form queries:** copy `cases/queries.example.json` to `cases/queries.json` for queries
  with no labels. They only run with `--judge` (or `--only queries`).

On hand-labelled cases the run also prints **judge vs your labels**: agreement on each peak, each
jump and each absent topic, and spot overlap in both directions. Under 80% agreement, don't trust
the judged numbers until the prompts in `eval/judge.js` are tightened.

Cost per case: one call per peak, one landing call, and one call that reads the whole transcript.
Verdicts are cached like Jev responses, keyed by model and prompt.

## 5. Is the eval itself right?
Five checks, from cheapest to most real:
1. **Metrics** (`--check`, no API): perfect answers (peaks = your labels) must score perfectly,
   or the scoring code is broken. It also prints two floors Jev has to beat on every line: random
   peaks, and one peak covering the whole video.
2. **Your labels** (`--check`): relabel ~10 queries a week later **without looking** at the old
   ones, into `cases/relabel.json` (same format). The run prints how far your two labellings
   differ. Start/end errors smaller than that gap are labelling noise, so don't tune to beat it.
3. **Luck** (every run): each number has a **[95% range]** from resampling the cases. If a change
   moves a number but stays inside the old range, it may be luck. More cases narrow the ranges.
4. **Noise** (`--repeat 3`): Jev can answer differently each time, and the cache hides that.
   Repeats are fresh samples (cached separately), and the run prints how much each number moves
   on its own. A change has to beat that spread.
5. **Overfitting** (`--split`): cases are split about 70/30 by video + query, and the split never
   changes. Tune on the default `tune` set, then check `--split holdout` **once** at the end. If
   holdout is much worse, the thresholds were fitted to the tune cases.

Also break something on purpose (e.g. `--set relT=0.95`) and check the numbers drop. If they
don't, the eval isn't measuring what you changed.

With `--judge`, labelled cases also print every **disagreement** between the judge and your
labels, with the judge's reason. Read them: fix your label when the judge is right, and tighten
the prompt in `judge.js` when it isn't.

The real test is people using it: how often they press Undo, press next, or keep watching after
a jump. If eval numbers improve but those don't, the eval is measuring the wrong thing.

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
