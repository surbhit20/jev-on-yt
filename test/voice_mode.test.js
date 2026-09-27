import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceEngine, VOICE_MODES } from '../src/voice_mode.js';

test('Accurate uses OpenAI only with a key; everything else is Chrome', () => {
  assert.equal(resolveVoiceEngine('accurate', true), 'openai');
  assert.equal(resolveVoiceEngine('accurate', false), 'chrome');
  assert.equal(resolveVoiceEngine('instant', true), 'chrome');
  assert.equal(resolveVoiceEngine(undefined, true), 'chrome');
  assert.deepEqual(VOICE_MODES, ['instant', 'accurate']);
});
