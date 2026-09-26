export function makeBridge(timeoutMs = 10000) {
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'jev-yt:res') return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  });

  return {
    call(type, payload) {
      const id = `${Date.now()}-${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge timeout: ${type}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ source: 'jev-yt:req', id, type, payload }, '*');
      });
    },
  };
}
