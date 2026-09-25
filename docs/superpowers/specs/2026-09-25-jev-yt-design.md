# Jev YT: design spec

Date: 2026-09-25
Source plan: `~/Downloads/jev_seek_plan.md` (this spec supersedes it where they differ)

## Goal

A Chrome extension (Manifest V3) for YouTube. The user asks, by voice or typing, about the video they are watching. The extension either jumps to the spot where the topic starts, or paints a heatmap on the progress bar showing where it is discussed. Scoring uses TypeSafe's Jev model; decisions are made in local code.

**Audience:** personal tool first, built so it can ship on the Chrome Web Store later. **Content:** any English YouTube video with a transcript. Shorts, live streams and premieres are out of scope for v1.

Distribution is bring your own key: the user pastes a TypeSafe API key on the options page. No backend.

## Product rules

1. **Automatic behaviour, no mode toggle.** Jump when confident; otherwise highlight. Never jump to a spot we are unsure about.
2. **The heatmap stays visible after a jump**, and the toast offers **[Undo]** (return to the previous time) and **[Show all]**.
3. **Not in the video → say so** ("Not discussed in this video") instead of highlighting noise.
4. **Highlight-only phrasing:** a query starting with "show", "where", "highlight" or "find" never jumps.
5. **One input:** hold Right Option to talk, double-tap Right Option to type.

## Differences from the source plan

| Plan | This spec |
|---|---|
| Folder `jev_seek/` | `jev-yt/` |
| Highlight/Jump toggle | Automatic (rule 1) plus phrasing override (rule 4) |
| Alt+J / Alt+Shift+J | Hold Right Option / double-tap Right Option |
| Floating panel | Wispr-style toast (see UI) |
| Transcript: `baseUrl&fmt=json3`, then panel scrape | YouTube's internal transcript API, then panel scrape (confirmed in Phase 0) |
| Fixed 30 s chunks | Adaptive chunk size (see Chunking) |
| `start_` pass on first query | Chapters when present; otherwise `start_` pass during prep |
| Jump to chunk start minus 3 s | Line-level refine pass, then line start minus 1.5 s |
| Concurrency cap 6 | Cap 10 |

## Architecture

```
jev-yt/
  manifest.json
  src/
    page_bridge.js      MAIN world: player response, transcript API call, chapters
    content.js          isolated world: per-video state machine, coordinates modules
    transcript.js       getTranscript(videoId): API method, then panel-scrape fallback
    chunker.js          pure: captions -> chunks -> windows
    query.js            pure: parse query (next/back, highlight-only, filler stripping)
    request_builder.js  pure: build Jev request bodies with deterministic ids
    scoring.js          pure: heat, segments, start point, decision
    config.js           pure: all thresholds and tunables
    background.js       service worker: Jev client, fan-out, retry, cache
    jev_client.js       fetch + retry/backoff (fetch injected for tests)
    voice.js            Web Speech wrapper, Right Option hold-to-talk
    ui/heatmap.js       progress-bar overlay
    ui/toast.js         Wispr-style toast
    ui/overlay.css
  options/options.html, options.js
  test/                 node --test, fixtures in test/fixtures/
  README.md
```

### Boundaries

- **`page_bridge.js`** is the only code that touches YouTube page internals. It is injected with `"world": "MAIN"` and talks to `content.js` via `window.postMessage` with a per-load nonce so other page scripts cannot spoof messages.
- **`background.js`** is the only code that holds the API key or calls `api.typesafe.ai`.
- **Pure modules** (`chunker`, `query`, `request_builder`, `scoring`, `config`) import no DOM or Chrome APIs.
- **Permissions:** `storage`; host permissions `https://www.youtube.com/*` and `https://api.typesafe.ai/*` only. No remote code.

### Per-video state machine (`content.js`)

`idle → preparing → ready → searching → result(jump | highlight | absent) → ready`
plus `unavailable` (no transcript) and `error`.
Resets on `yt-navigate-finish` when the video id changes. In-flight responses for an old video id are dropped.

## Data flow

### Prep (on watch-page load, silent)

1. `getTranscript(videoId)` → `[{ start, end, text }]`.
   - Primary: YouTube's internal transcript endpoint, called from the MAIN world using the page's own client context.
   - Fallback: open "Show transcript" programmatically, scrape segments, close the panel.
   - Language: prefer manual English, then auto-generated English. If none: state `unavailable`.
   - Cached per video id in memory and `chrome.storage.session`.
2. Read chapters from the player response, if present.
3. Chunk and window (below).
4. If there are no chapters: background runs the `start_` pass and caches it per video id. With chapters, no API call is made during prep.
5. State → `ready`. No UI is shown unless the user has already pressed the key.

### Query

1. The user holds Right Option and speaks (or double-taps and types). If state is `preparing`, the toast shows "Getting things ready…" and **keeps listening**; the query is queued and runs automatically on `ready`.
2. `query.js` parses the text: `next`/`back` → cycle matches locally (no API). The highlight-only prefix sets a flag. Filler ("skip to", "jump to", "take me to", "where he talks about", …) is stripped.
3. Background fans out one request per window (cap 10 concurrent, retry 429/529 with backoff of 500 ms doubling, max 4 tries).
4. `scoring.js` decides: absent, highlight or jump.
5. If jump (and not highlight-only): background runs the **refine pass**; seek to its result. On refine failure, seek to chunk start minus 3 s.
6. Cache the query's rel scores per (videoId, normalized query).

## Chunking (`chunker.js`)

- Target chunk length by video duration (`CONFIG.chunkSeconds`): under 20 min → 15 s; up to 2 h → 30 s; longer → 45 s.
- Merge caption lines up to the target, preferring to break at a sentence end within ±40% of the target.
- Chunk: `{ id: "C000", start, end, text, lineIdx: [first, last] }` (keeps line indices for the refine pass).
- Windows: at most 30 chunks, 1-chunk overlap. Overlapped chunk scores are averaged on merge.
- Window state: one line per chunk, `C014 [12:30] text…`.

## Jev requests (`request_builder.js`)

Endpoint `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, `Authorization: Bearer <key>`.

Per window, per query:
- `rel_<id>` Noul per chunk: "Does chunk <id> discuss or answer: \"<query>\"?". True: "This chunk substantively discusses the topic". False: "The topic is absent or only mentioned in passing".
- `best` Choice over the window's chunk ids (null descriptions): "Which chunk best answers: \"<query>\"?"
- `exists` Noul: "Does any chunk in this window substantively discuss: \"<query>\"?"

Per video, only when there are no chapters (`start_` pass):
- `start_<id>` Noul per chunk: "Does chunk <id> begin a new topic or discussion, rather than continue the previous one?"

Refine pass (only when jumping):
- State: the caption lines of the start chunk and the next chunk, one line each, `L0412 [1:41:58] text`.
- `line` Choice over those line ids (≤255): "Which line begins the discussion of: \"<query>\"?"

All question ids are deterministic. In dev mode, log `usage.input_tokens` and the elapsed time per request.

`exists` and `best` are kept for v1; the eval decides whether they earn their place.

## Scoring (`scoring.js`)

Inputs: per-chunk `rel`, per-chunk `start` (from chapters or the `start_` pass), per-window `best` and `exists`.

- **Heat:** smooth `rel` with a `[0.25, 0.5, 0.25]` kernel.
- **Chapter starts:** a chunk containing a chapter start → `start = 1`; others `0.3`.
- **Segments:** runs with `rel >= CONFIG.relT` (0.5), allowing a 1-chunk gap. Score = sum of `rel`; ×1.2 if it contains a window's `best`.
- **Absent:** max `exists < CONFIG.absentT` (0.35).
- **Jump:** max `exists >= CONFIG.foundT` (0.7) AND best segment score ≥ `CONFIG.margin` (1.5) × second best (or there is no second). Otherwise highlight.
- **Start point:** from the best segment's first chunk, walk back up to 3 chunks to the nearest chunk with `start >= 0.5`; the refine pass then picks the line.
- **Next/back:** segments ordered by score.

All thresholds live in `config.js`.

## UI

### Toast (`ui/toast.js`)

Dark, rounded, top-right of the player, ring-timer ✕. Only shown in response to user action or a result, never on page load.

| State | Content | Dismiss |
|---|---|---|
| Key pressed while preparing | ⏳ Getting things ready… Keep talking, I'll run it when ready | On ready |
| Listening | 🎙 Listening… + live interim text | On release |
| Typing | Text box | Enter / Esc |
| Searching | Searching "<query>"… (+ progress-bar shimmer) | On result |
| Jumped | ✓ Jumped to 1:42:09 · [Undo] [Show all] | Ring timer (4 s) |
| Highlight | Found N spots · say "next" or click one | Ring timer (6 s) |
| Absent | Not discussed in this video | Ring timer (4 s) |
| No transcript | No transcript for this video | Ring timer (4 s) |
| Error | Message + action (e.g. [Open settings]) | Manual |

### Heatmap (`ui/heatmap.js`)

An absolutely positioned layer over `.ytp-progress-bar`, one cell per chunk, colour and opacity from heat. It survives resize, theater and fullscreen (`ResizeObserver`). Clicking a hot cell seeks to its segment start. The landed segment pulses briefly after a jump. Esc clears it.

### Keys (content script, YouTube tab focused)

- **Hold Right Option** (`event.code === "AltRight"`) alone for ≥250 ms → start listening; release → submit.
- **Double-tap Right Option** (<350 ms apart) → typing toast.
- The hold is cancelled if any other key or a mouse button is pressed while held.
- Ignored while focus is in an input, textarea or contenteditable (except our own toast input).
- **←/→** while the toast is open → back/next. **Esc** → close toast / clear heatmap.
- Windows: the same with right Alt; suppress the browser menu focus on keyup.

### Options page

API key field, **Test key** button (sends a one-question Noul; reports success or 401/422/429/529/network), and a note: the key stays in this browser and is sent only to TypeSafe. Setting: "Show toast on results" (default on).

## Error handling

| Failure | Behaviour |
|---|---|
| No key set | Toast: "Add your TypeSafe key" [Open settings]; prep still runs (free parts) |
| 401 | Toast: "TypeSafe key rejected" [Open settings]; no retry |
| 422 | Dev log with request id and body shape; toast "Something went wrong" |
| 429 / 529 | Retry with backoff; after 4 tries, toast "TypeSafe is busy, try again" |
| Network / offline | Toast "Can't reach TypeSafe" |
| One window fails after retries | Score the rest; mark failed chunks as unknown (grey); never jump if the best segment touches an unknown window |
| Transcript unavailable | State `unavailable`; toast on key press |
| Speech error / mic denied | Toast "Mic blocked, double-tap Right Option to type" |
| Video changed mid-query | Drop the response |

The API key is never logged, and is never sent anywhere except `api.typesafe.ai`.

## Privacy (README; becomes the store privacy policy)

Sent to TypeSafe: transcript text of the current video and the query. Sent to Google: voice audio, via Chrome's Web Speech API, only while Right Option is held. Nothing else leaves the browser. No analytics.

## Testing

- **Unit (`node --test`):** `chunker`, `query`, `request_builder`, `scoring`, `jev_client` (with injected fake fetch covering retry, 401 and 429 paths). Fixtures: one real long transcript and one short one in `test/fixtures/`.
- **Manual checks per phase** (below).
- **Eval:** 12 queries across 4 videos (2 long podcasts, 1 lecture of 30–60 min, 1 short video of ~10 min), each with a human-judged correct timestamp, plus 2 absent-topic queries. Metric: jump lands within 30 s before to 60 s after the true start; absent queries correctly say "not discussed". Tune `config.js` against it.

## Build phases

Each phase ends with tests passing and a short report.

0. **Transcript spike.** `page_bridge` + `transcript.js`; log the first and last 5 lines. Test: a 2 h podcast, an auto-captions-only video, a no-captions video, and SPA navigation between two videos. Confirm the primary/fallback order.
1. **Chunker, request builder, Jev client, options page.** Unit tests. Test key works. **Measure one real window request: latency and `usage.input_tokens` for ~32 questions over ~3k tokens.**
2. **End to end in the console.** Prep + query fan-out + `scoring.js` + refine pass; log scores and the chosen time. Done when a clearly discussed topic in a long podcast gives a sensible timestamp.
3. **Heatmap + toast.** Normal, theater and fullscreen; click to seek; shimmer.
4. **Automatic decision UX.** Jump / highlight / absent, Undo, Show all, next/back, highlight-only phrasing, queued query during prep.
5. **Voice.** Right Option hold-to-talk, double-tap to type, voice next/back.
6. **Polish and eval.** Error toasts, caching, README with privacy note, eval run and threshold tuning.

## Out of scope for v1

Sites other than YouTube (transcript access stays behind `getTranscript` so others can be added); "watch only matching parts" playback; paid or local speech engines; videos without captions; non-English; Shorts and live streams; key-less trial mode.
