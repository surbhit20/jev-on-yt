# Jev YT

Ask a YouTube video a question and jump to the answer. Hold **Control** and say
"skip to where he talks about caffeine", and the video jumps there. If the answer isn't clear,
the progress bar lights up where the topic is discussed instead.

Scoring uses [TypeSafe](https://typesafe.ai)'s Jev model with your own API key.

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repo folder.
3. Click the Jev YT toolbar icon, paste your TypeSafe API key, and click **Save**, then **Test key**.

## Use

| Action | How |
|---|---|
| Ask by voice | Hold **Control**, speak, release |
| Ask by typing | Double-tap **Control** |
| Next / previous match | Say "next" / "back", or press → / ← while the toast is open |
| Undo a jump | **Undo** in the toast |
| Clear highlights | **Esc** |

The first time you hold Control, Chrome asks for microphone access for youtube.com.

Questions that start with "show", "where", "find" or "highlight" only highlight, never jump.

## Privacy

- Your API key is stored in this browser (`chrome.storage.local`) and sent only to `api.typesafe.ai`.
- The transcript of the video you're watching and your question are sent to TypeSafe to score.
- While Control is held, Chrome's built-in speech recognition sends your voice to Google.
- Voice uses Chrome's speech recognition on youtube.com, so Chrome asks to allow the microphone for youtube.com; that permission also lets YouTube itself use the mic.
- Nothing else leaves the browser. No analytics.

## Development

- `npm test` runs the unit tests (Node 20+).
- Debug from the YouTube tab's DevTools: choose the **Jev YT** console context and run
  `await jev.ask("your question")`. API timings and token counts are logged in the extension's
  service worker console.
