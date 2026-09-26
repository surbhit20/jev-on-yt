import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase64, fromBase64, buildTranscriptionRequest, readTranscription, callTranscribe,
} from '../src/openai_transcribe.js';

const CFG = { endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-mini-transcribe', language: 'en' };

test('base64 round trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('buildTranscriptionRequest: POST multipart with model, language, json format and the audio file', async () => {
  const { url, init } = buildTranscriptionRequest({
    base64: toBase64(new Uint8Array([1, 2, 3])), mimeType: 'audio/webm;codecs=opus', apiKey: 'sk-x', config: CFG,
  });
  assert.equal(url, CFG.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk-x');
  assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(init.body.get('language'), 'en');
  assert.equal(init.body.get('response_format'), 'json');
  const file = init.body.get('file');
  assert.equal(file.name, 'speech.webm');
  assert.equal(file.type, 'audio/webm');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('readTranscription trims text and tolerates a missing field', () => {
  assert.equal(readTranscription({ text: '  skip to caffeine ' }), 'skip to caffeine');
  assert.equal(readTranscription({}), '');
});

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('callTranscribe: text on success; openai:<status> and openai:network errors', async () => {
  const args = { base64: toBase64(new Uint8Array([1])), mimeType: 'audio/webm', apiKey: 'k', config: CFG };
  assert.equal(await callTranscribe({ ...args, fetchImpl: async () => response(200, { text: 'hello' }) }), 'hello');
  await assert.rejects(callTranscribe({ ...args, fetchImpl: async () => response(401, {}) }), (e) => e.status === 'openai:401');
  await assert.rejects(callTranscribe({ ...args, fetchImpl: async () => { throw new Error('offline'); } }), (e) => e.status === 'openai:network');
});
