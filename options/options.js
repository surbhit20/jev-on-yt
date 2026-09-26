const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

const MESSAGES = {
  401: 'Key rejected (401). Check it and try again.',
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
