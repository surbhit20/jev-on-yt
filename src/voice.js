// Web Speech wrapper for hold-to-talk. Chrome sends the audio to Google's speech service
// while Control is held (documented in the README privacy note).
export function createVoice({ lang, onInterim }) {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let rec = null;
  let finalText = '';
  let interimText = '';
  let error = null;
  let pending = [];

  function abort() {
    if (!rec) return;
    const r = rec;
    rec = null;
    const toResolve = pending;
    pending = [];
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try { r.abort(); } catch {}
    // Flush all pending resolvers with aborted error
    for (const resolve of toResolve) {
      resolve({ text: '', error: 'aborted' });
    }
  }

  function start() {
    if (!SR) throw new Error('unsupported');
    abort();
    finalText = '';
    interimText = '';
    error = null;
    rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let fin = '';
      let tmp = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else tmp += r[0].transcript;
      }
      finalText = fin;
      interimText = tmp;
      onInterim?.(`${fin}${tmp}`.trim());
    };
    rec.onerror = (e) => { error = e.error; };
    rec.onend = () => {
      rec = null;
      const result = { text: `${finalText}${interimText}`.trim(), error };
      const toResolve = pending;
      pending = [];
      for (const resolve of toResolve) {
        resolve(result);
      }
    };
    rec.start();
  }

  function stop() {
    return new Promise((resolve) => {
      if (!rec) {
        return resolve({ text: `${finalText}${interimText}`.trim(), error });
      }
      pending.push(resolve);
      rec.stop();
    });
  }

  return { supported: !!SR, start, stop, abort };
}

// Records the mic while Control is held, for OpenAI transcription. Same shape as createVoice:
// stop() resolves { audio: { base64, mimeType, bytes } | null, error }.
export function createRecorderVoice({ toBase64 }) {
  const supported = !!(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  let session = null;

  const release = (s) => s.stream?.getTracks().forEach((t) => t.stop());

  function start() {
    if (!supported) throw new Error('unsupported');
    abort();
    const s = { chunks: [], stream: null, recorder: null, error: null, cancelled: false };
    s.ready = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        s.stream = stream;
        if (s.cancelled) return release(s);
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
        s.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        s.recorder.ondataavailable = (e) => { if (e.data?.size) s.chunks.push(e.data); };
        s.recorder.start();
      })
      .catch((e) => { s.error = e?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture'; });
    session = s;
  }

  async function stop() {
    const s = session;
    session = null;
    if (!s) return { audio: null, error: null };
    await s.ready;
    if (s.error || !s.recorder) {
      release(s);
      return { audio: null, error: s.error ?? 'aborted' };
    }
    const stopped = new Promise((r) => { s.recorder.onstop = r; });
    s.recorder.stop();
    await stopped;
    release(s);
    const blob = new Blob(s.chunks, { type: s.recorder.mimeType || 'audio/webm' });
    const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
    return { audio: { base64, mimeType: blob.type, bytes: blob.size }, error: null };
  }

  function abort() {
    const s = session;
    session = null;
    if (!s) return;
    s.cancelled = true;
    s.ready?.then(() => {
      try { if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop(); } catch {}
      release(s);
    });
  }

  return { supported, start, stop, abort };
}
