import { DEFAULT_VOICE_MODE } from '../src/voice_mode.js';
import { CONFIG } from '../src/config.js';

const $ = (id) => document.getElementById(id);
const HINTS = {
  instant: "Chrome's built-in voice. Words appear as you talk.",
  accurate: 'OpenAI transcription. Better with names, about a second slower.',
};

async function hasOpenAIKey() {
  const { openaiKey } = await chrome.storage.local.get('openaiKey');
  if (!openaiKey) return false;
  return chrome.permissions.contains({ origins: ['https://api.openai.com/*'] });
}

function render(mode) {
  $('switch').dataset.mode = mode;
  $('instant').setAttribute('aria-pressed', String(mode === 'instant'));
  $('accurate').setAttribute('aria-pressed', String(mode === 'accurate'));
  $('hint').textContent = HINTS[mode];
}

async function choose(mode) {
  if (mode === 'accurate' && !(await hasOpenAIKey())) {
    $('notice').hidden = false;
    return;
  }
  $('notice').hidden = true;
  await chrome.storage.local.set({ voiceMode: mode });
  render(mode);
}

const { voiceMode = DEFAULT_VOICE_MODE } = await chrome.storage.local.get('voiceMode');
// A saved Accurate mode whose key was removed shows as Instant, which is what actually runs.
render(voiceMode === 'accurate' && !(await hasOpenAIKey()) ? 'instant' : voiceMode);

$('instant').addEventListener('click', () => choose('instant'));
$('accurate').addEventListener('click', () => choose('accurate'));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('addKey').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Dev: ask the YouTube tab to download its transcript or voice log for the evals.
async function devExport(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    res = { ok: false, error: 'Open a YouTube video first.' };
  }
  $('devStatus').textContent = res?.ok ? `Downloaded${res.count ? ` (${res.count} lines)` : ''}.` : res?.error ?? 'No response.';
}
if (CONFIG.dev) {
  $('dev').hidden = false;
  $('exportTranscript').addEventListener('click', () => devExport('exportTranscript'));
  $('exportVoiceLog').addEventListener('click', () => devExport('exportVoiceLog'));
}
