// Web Speech wrapper for hold-to-talk. Chrome sends the audio to Google's speech service
// while Right Option is held (documented in the README privacy note).
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
