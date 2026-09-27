// npm run package → dist/flash-<version>.zip, ready to upload to the Chrome Web Store.
// Copies only what the extension loads (no eval/, docs/, test/), with dev mode switched off.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', 'flash');
rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ['manifest.json', 'src', 'popup', 'options']) cpSync(join(root, f), join(out, f), { recursive: true });
mkdirSync(join(out, 'icons'));
for (const size of Object.keys(manifest.icons)) cpSync(join(root, manifest.icons[size]), join(out, manifest.icons[size]));

const configFile = join(out, 'src', 'config.js');
const config = readFileSync(configFile, 'utf8');
if (!/^\s*dev: true,$/m.test(config)) throw new Error('src/config.js: expected a "dev: true," line to switch off');
writeFileSync(configFile, config.replace(/^(\s*)dev: true,$/m, '$1dev: false,'));

// Every file the manifest names must be in the build.
const named = [
  manifest.background.service_worker, manifest.options_page, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css ?? [])]),
  ...manifest.web_accessible_resources.flatMap((w) => w.resources),
];
const missing = named.filter((f) => !existsSync(join(out, f)));
if (missing.length) throw new Error(`missing from build: ${missing.join(', ')}`);

const zip = join(root, 'dist', `flash-${manifest.version}.zip`);
execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
console.log(`dist/flash-${manifest.version}.zip (dev off). Load dist/flash unpacked to test it before uploading.`);
