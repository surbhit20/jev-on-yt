import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

function importsOf(file) {
  const src = readFileSync(join(root, file), 'utf8');
  return [...src.matchAll(/^import .* from '(\.[^']+)';$/gm)].map((m) => normalize(join(dirname(file), m[1])));
}

test('every module app.js loads is web-accessible, without use_dynamic_url', () => {
  const seen = new Set();
  const stack = ['src/app.js'];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  const war = manifest.web_accessible_resources.flatMap((w) => w.resources);
  for (const f of seen) assert.ok(war.includes(f), `${f} missing from web_accessible_resources`);
  for (const w of manifest.web_accessible_resources) assert.equal(w.use_dynamic_url, undefined);
});

test('content script injects the overlay CSS and the toolbar icon opens settings', () => {
  const cs = manifest.content_scripts.find((c) => c.js.includes('src/content.js'));
  assert.deepEqual(cs.css, ['src/ui/overlay.css']);
  assert.ok(manifest.action);
  assert.deepEqual(manifest.permissions, ['storage']);
});
