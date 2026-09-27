import { formatTime } from '../time.js';

export function errorToast(err) {
  const s = err?.status;
  if (s === 'nokey') return { title: 'Add your TypeSafe key', settings: true };
  if (s === 401) return { title: 'TypeSafe key rejected', settings: true };
  if (s === 403) return { title: 'TypeSafe denied access. Check your key or plan', settings: true };
  if (s === 429 || s === 529) return { title: 'TypeSafe is busy, try again', settings: false };
  if (s === 'network') return { title: "Can't reach TypeSafe", settings: false };
  if (s === 'openai:401') return { title: 'OpenAI key rejected', settings: true };
  if (s === 'openai:network') return { title: "Couldn't reach OpenAI", settings: false };
  if (String(s).startsWith('openai:')) return { title: "Transcription didn't work, try again", settings: false };
  return { title: 'Something went wrong', settings: false };
}

export const spotsLabel = (n) => (n === 1 ? '1 spot' : `${n} spots`);

export const matchLabel = (i, n, timeSec) => `Match ${i + 1} of ${n} · ${formatTime(timeSec)}`;
