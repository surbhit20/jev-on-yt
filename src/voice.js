// Web Speech wrapper for hold-to-talk. Chrome sends the audio to Google's speech service
// while Right Option is held (documented in the README privacy note).
export function createVoice({ lang, onInterim }) {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let rec = null;
  let finalText = '';
  let interimText = '';
  let error = null;
  let onEnd = null;

  function abort() {
    if (!rec) return;
    const r = rec;
    rec = null;
    onEnd = null;
    r.onend = null;
    try { r.abort(); } catch {}
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
      const cb = onEnd;
      onEnd = null;
      cb?.();
    };
    rec.start();
  }

  function stop() {
    return new Promise((resolve) => {
      const done = () => resolve({ text: `${finalText}${interimText}`.trim(), error });
      if (!rec) return done();
      onEnd = done;
      rec.stop();
    });
  }

  return { supported: !!SR, start, stop, abort };
}
