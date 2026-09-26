# Jev YT

Ask a YouTube video a question and jump to the answer. Hold **Control** and say
"skip to where he talks about caffeine", and the video jumps there. If the answer isn't clear,
the progress bar lights up where the topic is discussed instead.

Scoring uses [TypeSafe](https://typesafe.ai)'s Jev model with your own API key.

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repo folder.
3. Click the Jev YT toolbar icon, paste your TypeSafe API key, and click **Save**, then **Test key**.
4. Optional: add an OpenAI API key under **Voice**, then pick **Accurate** from the toolbar button's popup. **Instant** (the default) uses Chrome's built-in voice.

## Use

| Action | How |
|---|---|
| Ask by voice | Hold **Control**, speak, release |
| Ask by typing | Double-tap **Control** |
| Next / previous match | Click a lime peak (it jumps to where that part starts), press → / ← while the toast is open, or say "next" / "back" |
| Undo a jump | **Undo** in the toast |
| Clear highlights | **Esc** |

While you hold Control the video pauses so its audio doesn't mix into your question, and it resumes when you let go (set `whileListening` in `src/config.js` to `'mute'` or `'none'` to change this).

The first time you hold Control, Chrome asks for microphone access for youtube.com.

Questions that start with "show", "where", "find" or "highlight" only highlight, never jump.

## Privacy

- Your API key is stored in this browser (`chrome.storage.local`) and sent only to `api.typesafe.ai`.
- The transcript of the video you're watching and your question are sent to TypeSafe to score.
- Voice: by default, while Control is held, Chrome's built-in speech recognition sends your voice to Google. In Accurate mode (needs an OpenAI key), the recording is sent to OpenAI (gpt-4o-mini-transcribe) instead, and only then does the extension get access to `api.openai.com`.
- Voice uses Chrome's speech recognition on youtube.com, so Chrome asks to allow the microphone for youtube.com; that permission also lets YouTube itself use the mic.
- Nothing else leaves the browser. No analytics.

## Development

- `npm test` runs the unit tests (Node 20+).
- Debug from the YouTube tab's DevTools: choose the **Jev YT** console context and run
  `await jev.ask("your question")`. API timings and token counts are logged in the extension's
  service worker console.
