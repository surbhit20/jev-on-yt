// Voice-to-text scoring. Pure.

export const words = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);

// Word error rate: word-level edit distance / reference length.
export function wer(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[h.length] / r.length;
}

// Share of key terms (each one or more words) that appear, in order, in the hypothesis.
export function keyTermsKept(hypothesis, terms) {
  if (!terms?.length) return null;
  const h = ` ${words(hypothesis).join(' ')} `;
  return terms.filter((t) => h.includes(` ${words(t).join(' ')} `)).length / terms.length;
}
