# Evals: brainstorm notes (in progress)

Status: brainstorming, not yet a spec. Continue from "Open question" below.

## Context
- Branch `feat/openai-voice` (pushed, not merged): optional OpenAI transcription + toolbar popup
  with Instant / Accurate voice modes. Waiting for the user's Chrome test, then merge to `main`.
- Evals build on top of that branch.

## Decided with the user
Metrics to measure:
1. Start accuracy for every true spot (seconds between the true start and our matching peak's start).
2. End accuracy for every true spot (same for the end).
3. All peaks, not just the main one: recall (true spots that got a peak) and false peaks
   (peaks where the topic isn't discussed).
4. Jump accuracy: lands within 30 s before to 60 s after the true start of the main spot.
- Pending confirmation: user said "transcription accuracy"; interpreted as start/end
  correctness. If they meant voice-to-text accuracy, add a separate STT check.

## Open question (asked, not answered)
Where does ground truth come from?
- A) Chapters as free ground truth (chapter title = query, chapter start/end = truth) — recommended.
- B) User hand-labels ~10 questions across 3–4 videos (every spot's start and end).
- C) Both: chapters for volume + ~10 hand-labelled (multi-spot topics, absent topics).

## Likely approach (not yet proposed to the user)
Node eval runner reusing the pure pipeline (chunker, request_builder, pipeline, scoring) against
the real Jev API (key from env), on transcripts exported once from the extension
(`jev.video.lines` / chapters → JSON in `eval/data/`). Report per-case and aggregate metrics.
