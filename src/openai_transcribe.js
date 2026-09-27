// OpenAI speech-to-text, used instead of Chrome's built-in voice when the user saves an OpenAI key.
// Pure apart from the injected fetch; runs in the background worker, which alone holds the key.

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function buildTranscriptionRequest({ base64, mimeType, apiKey, config }) {
  const type = String(mimeType).split(';')[0] || 'audio/webm';
  const body = new FormData();
  body.append('file', new Blob([fromBase64(base64)], { type }), 'speech.webm');
  body.append('model', config.model);
  body.append('language', config.language);
  body.append('response_format', 'json');
  return {
    url: config.endpoint,
    init: { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body },
  };
}

export function readTranscription(json) {
  return String(json?.text ?? '').trim();
}

// Errors carry status 'openai:<http status>' or 'openai:network' for the UI to map.
export async function callTranscribe({ base64, mimeType, apiKey, config, fetchImpl = globalThis.fetch }) {
  const { url, init } = buildTranscriptionRequest({ base64, mimeType, apiKey, config });
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw Object.assign(new Error(`OpenAI unreachable: ${e?.message ?? e}`), { status: 'openai:network' });
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw Object.assign(new Error(`OpenAI ${res.status}: ${detail}`), { status: `openai:${res.status}` });
  }
  return readTranscription(await res.json());
}
