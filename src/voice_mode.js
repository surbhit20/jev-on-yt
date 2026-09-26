// Voice mode chosen in the toolbar popup, stored once in chrome.storage.local as `voiceMode`
// so it applies to every tab. Instant = Chrome's built-in voice; Accurate = OpenAI transcription.
export const VOICE_MODES = ['instant', 'accurate'];
export const DEFAULT_VOICE_MODE = 'instant';

export function resolveVoiceEngine(mode, hasOpenAIKey) {
  return mode === 'accurate' && hasOpenAIKey ? 'openai' : 'chrome';
}
