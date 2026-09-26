export class JevError extends Error {
  constructor(status, message) {
    super(`Jev ${status}: ${message}`);
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callJev(body, { apiKey, endpoint, fetchImpl = globalThis.fetch, tries = 4, baseMs = 500, sleep = defaultSleep }) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new JevError('network', e?.message ?? String(e));
    }
    if (res.ok) return { data: await res.json(), ms: Date.now() - t0, attempts: attempt + 1 };
    if ((res.status === 429 || res.status === 529) && attempt < tries - 1) {
      await sleep(baseMs * 2 ** attempt);
      continue;
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new JevError(res.status, detail);
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
