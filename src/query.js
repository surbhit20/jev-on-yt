const VERBS = [
  'talk', 'talks', 'talking', 'discuss', 'discusses', 'discussing', 'mention', 'mentions', 'mentioning',
  'speak', 'speaks', 'speaking', 'explain', 'explains', 'explaining', 'cover', 'covers', 'covering',
  'go over', 'goes over', 'get into', 'gets into', 'say', 'says',
].join('|');
const WHO = ['he', 'she', 'they', 'we', 'you', 'someone', 'somebody', 'the speaker', 'the host', 'the guest', 'it',
  "he's", "she's", "they're"].join('|');

// Applied in order, each at most once, to strip command phrasing.
const FILLERS = [
  /^(please|hey|ok|okay)\s+/,
  /^(can|could) you\s+/,
  /^(skip|jump|go|take me|fast forward|seek|move|bring me)(\s+(ahead|forward|back))?(\s+to)?\s+/,
  /^(show|highlight|find)(\s+me)?\s+/,
  /^(the\s+)?(part|bit|section|moment|spot|place|point)s?\s+(about|on|where|when)\s+/,
  new RegExp(`^(where|when)(\\s+(does|do|did|is|are|was))?(\\s+(${WHO}))?(\\s+(is|are|was))?(\\s+(${VERBS}))?(\\s+(about|on))?\\s+`),
  new RegExp(`^(${WHO})(\\s+(is|are|was))?\\s+(${VERBS})(\\s+(about|on))?\\s+`),
  /^(about|on|regarding)\s+/,
];

const NEXT = /^(next|next one|go next)$/;
const BACK = /^(back|go back|previous|prev|previous one|last one)$/;
const HIGHLIGHT_ONLY = /^(show|where|highlight|find)\b/;
// A command with nothing after it ("jump to", "show me") has no topic.
const BARE_COMMAND = /^((skip|jump|go|take me|fast forward|seek|move|bring me)(\s+(ahead|forward|back))?(\s+to)?|(show|highlight|find)(\s+me)?)$/;

export function parseQuery(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?.!,;:]+$/, '').trim();
  const none = { query: '', highlightOnly: false };
  if (!text) return { kind: 'empty', ...none };
  if (NEXT.test(text)) return { kind: 'next', ...none };
  if (BACK.test(text)) return { kind: 'back', ...none };
  if (BARE_COMMAND.test(text)) return { kind: 'empty', ...none };

  const highlightOnly = HIGHLIGHT_ONLY.test(text);
  let q = text;
  for (const re of FILLERS) q = q.replace(re, '');
  q = q.trim();
  if (!q) return { kind: 'empty', ...none };
  return { kind: 'search', query: q, highlightOnly };
}
