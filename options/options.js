const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

const MESSAGES = {
  401: 'Key rejected (401). Check it and try again.',
  403: 'Access denied (403). Check your key or TypeSafe plan.',
  422: 'Request rejected (422). Please report this.',
  429: 'Rate limited (429). Try again shortly.',
  529: 'TypeSafe is overloaded (529). Try again shortly.',
  network: "Can't reach TypeSafe. Check your connection.",
  nokey: 'Paste a key first.',
};

const { apiKey } = await chrome.storage.local.get('apiKey');
if (apiKey) $('key').value = apiKey;

$('save').addEventListener('click', async () => {
  const value = $('key').value.trim();
  await chrome.storage.local.set({ apiKey: value });
  setStatus(value ? 'Saved.' : 'Key cleared.');
});

$('test').addEventListener('click', async () => {
  setStatus('Testing…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'testKey', apiKey: $('key').value.trim() || undefined });
    if (res?.ok) {
      const tokens = res.result.usage?.input_tokens;
      setStatus(`Key works (${res.result.ms} ms${tokens != null ? `, ${tokens} input tokens` : ''}).`);
    } else {
      setStatus(MESSAGES[res?.error?.status] ?? `Error: ${res?.error?.message ?? 'unknown'}`);
    }
  } catch (e) {
    setStatus(`Error: ${e?.message ?? 'unknown'}`);
  }
});

// Optional OpenAI key for voice. Saving asks Chrome for access to api.openai.com (only then).
const OPENAI_ORIGIN = 'https://api.openai.com/*';
const setOStatus = (t) => { $('ostatus').textContent = t; };
const OPENAI_MESSAGES = {
  'openai:401': 'Key rejected (401). Check it and try again.',
  'openai:429': 'Rate limited or out of credit (429).',
  'openai:network': "Can't reach OpenAI. Check your connection.",
  'openai:nokey': 'Paste a key first.',
};

const { openaiKey } = await chrome.storage.local.get('openaiKey');
if (openaiKey) $('okey').value = openaiKey;

$('osave').addEventListener('click', async () => {
  const value = $('okey').value.trim();
  if (!value) {
    await chrome.storage.local.remove('openaiKey');
    await chrome.permissions.remove({ origins: [OPENAI_ORIGIN] }).catch(() => {});
    setOStatus("Key removed. Voice uses Instant (Chrome's built-in recognition).");
    return;
  }
  // Must run straight from the click, before any other await, or Chrome refuses the prompt.
  const granted = await chrome.permissions.request({ origins: [OPENAI_ORIGIN] });
  if (!granted) {
    setOStatus('Chrome access to api.openai.com is needed to use this key. Not saved.');
    return;
  }
  await chrome.storage.local.set({ openaiKey: value });
  setOStatus('Saved. Choose Accurate from the Jev YT toolbar button to use it.');
});

$('otest').addEventListener('click', async () => {
  // Testing also needs access to api.openai.com; ask from the click, like Save.
  const granted = await chrome.permissions.request({ origins: [OPENAI_ORIGIN] });
  if (!granted) {
    setOStatus('Chrome access to api.openai.com is needed to test this key.');
    return;
  }
  setOStatus('Testing…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'testOpenAI', apiKey: $('okey').value.trim() || undefined });
    setOStatus(res?.ok ? 'Key works.' : OPENAI_MESSAGES[res?.error?.status] ?? `Error: ${res?.error?.message ?? 'unknown'}`);
  } catch (e) {
    setOStatus(`Error: ${e?.message ?? 'unknown'}`);
  }
});
