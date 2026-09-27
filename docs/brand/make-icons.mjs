// Regenerates icons/*.png and docs/brand/flash-icon-preview.png: node docs/brand/make-icons.mjs (needs Playwright + Chromium).
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
const OUT = new URL('../../icons', import.meta.url).pathname;
// Rounded "screen" (slightly bowed sides) with a bolt in the middle, on a 128 grid.
const BODY = 'M30 22 C50 20.5 78 20.5 98 22 C112 23 120 30 121 44 C122.5 58 122.5 70 121 84 C120 98 112 105 98 106 C78 107.5 50 107.5 30 106 C16 105 8 98 7 84 C5.5 70 5.5 58 7 44 C8 30 16 23 30 22 Z';
const BOLT = [[72.8, 37.6], [50.2, 67.5], [64.7, 67.5], [55.4, 89.6], [78.0, 59.6], [65.2, 59.6]];
function svg({ stroke, boltScale }) {
  const [cx, cy] = [64, 63.6];
  const pts = BOLT.map(([x, y]) => `${(cx + (x - cx) * boltScale).toFixed(1)} ${(cy + (y - cy) * boltScale).toFixed(1)}`).join(' L');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <path d="${BODY}" fill="#fff" stroke="#111" stroke-width="${stroke}" stroke-linejoin="round"/>
  <path d="M${pts} Z" fill="#111"/>
</svg>
`;
}
// Small sizes get a heavier outline and a bigger bolt so they survive the toolbar.
const VARIANTS = { 128: { stroke: 6, boltScale: 1 }, 48: { stroke: 8, boltScale: 1.15 }, 32: { stroke: 10, boltScale: 1.3 }, 16: { stroke: 13, boltScale: 1.45 } };
writeFileSync(`${OUT}/flash.svg`, svg(VARIANTS[128]));
writeFileSync(`${OUT}/flash-small.svg`, svg(VARIANTS[16]));
const b = await chromium.launch();
for (const [size, v] of Object.entries(VARIANTS)) {
  const p = await b.newPage({ viewport: { width: +size, height: +size } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg(v)).toString('base64')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: `${OUT}/icon-${size}.png`, omitBackground: true });
  await p.close();
}
// Preview: every size on a light and a dark toolbar.
const p = await b.newPage({ viewport: { width: 560, height: 300 }, deviceScaleFactor: 2 });
const row = (bg, fg) => `<div style="background:${bg};color:${fg};padding:18px 22px;display:flex;gap:26px;align-items:center;font:13px system-ui">
  ${[128, 48, 32, 16].map((s) => `<img src="data:image/png;base64,${readFileSync(`${OUT}/icon-${s}.png`).toString('base64')}" width="${s}" height="${s}">`).join('')}<span>${bg === '#fff' ? 'light toolbar' : 'dark toolbar'}</span></div>`;
await p.setContent(`<body style="margin:0">${row('#fff', '#555')}${row('#202124', '#aaa')}</body>`);
await p.screenshot({ path: `${OUT}/../docs/brand/flash-icon-preview.png`, fullPage: true });
await b.close();
