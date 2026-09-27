# Publishing Flash to the Chrome Web Store

## 1. Before uploading
- [ ] **Test the release build in Chrome.** `npm run package`, then on `chrome://extensions` remove
      the dev copy, **Load unpacked** → `dist/flash`, and run through: typed question, voice in
      Instant, voice in Accurate, a video with chapters, one without, a video with no captions.
      The voice modes and the shared search code have not been tried in Chrome yet.
- [ ] Bump `version` in `manifest.json` for every new upload (the store rejects a repeated version).
- [ ] Host `PRIVACY.md` at a public URL (GitHub Pages, a public gist, or Notion) after putting your
      contact email in it.
- [ ] Developer account: [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole),
      one-time registration fee, 2-step verification on the Google account.

## 2. Store listing
- **Name:** Flash
- **Summary** (≤132 chars): *Ask a YouTube video a question and jump straight to the answer. Hold Control, speak, and Flash takes you there.*
- **Category:** Productivity
- **Description:** what it does, how to use it (hold Control / double-tap to type), and clearly:
  *"Needs your own TypeSafe API key (typesafe.ai). An OpenAI key is optional, for the Accurate voice mode."*
  Use "YouTube" only to describe what it works on; don't imply it's made by or endorsed by YouTube.
- **Images:** the 128 px icon (in the zip), at least one screenshot at 1280×800 (a real YouTube
  page with the peaks and a toast showing), and a 440×280 small promo tile.

## 3. Privacy practices tab
**Single purpose:** *Find the part of a YouTube video that answers the user's question, and jump
the player to it.*

**Permission justifications:**
| Permission | Why |
|---|---|
| `storage` | Saves the user's API keys and voice mode on the device, and caches search results for the session. |
| Host `https://www.youtube.com/*` | Reads the transcript of the open video and draws the answer peaks and messages on the player. |
| Host `https://api.typesafe.ai/*` | Sends the transcript and the question to TypeSafe (with the user's key) to find the answer. |
| Optional host `https://api.openai.com/*` | Only if the user adds an OpenAI key: sends the voice recording for transcription in Accurate mode. Requested at runtime. |

**Remote code:** No. All code is in the package.

**Data usage** (tick these; all must match `PRIVACY.md`):
- *Website content* (video transcripts), sent to TypeSafe to answer the question.
- *User activity* is **not** collected. *Personal communications*: not collected. *Authentication
  information*: API keys, stored locally and sent only to their own service.
- Voice: audio is sent to Google (Instant) or OpenAI (Accurate) only while the user holds Control.
- Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** the hosted `PRIVACY.md`.

## 4. Test instructions for the reviewer
Reviewers can't use Flash without a key. In the dashboard's test instructions field, give them a
TypeSafe key (a separate one you can revoke afterwards) and the steps:
1. Click the toolbar icon → Settings, paste the key, Save.
2. Open a YouTube video with captions, wait for it to load.
3. Double-tap Control, type a question about the video, press Enter. The video jumps to the answer.

## 5. Likely review issues
- **Icon and name:** the rounded-screen icon resembles YouTube's play button, and "Flash" is a DC
  trademark. Either can get the listing rejected for impersonation or trademark; if it happens,
  change the icon shape (squarer, no side bulge) and consider "Flash for YouTube" or a new name.
- **Broad-looking permissions:** keep the justifications above word for word; they match the code.
- Review usually takes a few days; new developer accounts can take longer.
