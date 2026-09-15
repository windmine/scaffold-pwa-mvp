import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Keep app artwork and approved export logos as the source of truth. PNGs let the
// Python-only production image render department branding without SVG libraries.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'backend/app/assets/report-logos');
const sources = [
  { brand: 'mc', source: 'mc-logo.svg', width: 640, height: 220 },
  { brand: 'stech', source: 'stech-logo.svg', width: 640, height: 220 },
  { brand: 'bop', source: 'bop-logo.svg', width: 640, height: 220 },
  { brand: 'reportflow', source: 'reportflow-icon.svg', width: 512, height: 512 }
];

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(resolve(root, 'assets/icons/leader-logo-export.png'), resolve(outputDirectory, 'leader.png'));
// Preserve the supplied Mutual artwork byte-for-byte; don't recreate it from
// the retained full-interface SVG placeholder.
copyFileSync(resolve(root, 'assets/icons/mutual-logo-export.png'), resolve(outputDirectory, 'mutual.png'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const { brand, source, width, height } of sources) {
    const artwork = readFileSync(resolve(root, 'assets/icons', source), 'utf8');
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      svg { display: block; width: 100%; height: 100%; }
    </style></head><body>${artwork}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.screenshot({ omitBackground: true, animations: 'disabled' });
    assert.equal(bytes.readUInt32BE(16), width * 2, `${brand} width`);
    assert.equal(bytes.readUInt32BE(20), height * 2, `${brand} height`);
    writeFileSync(resolve(outputDirectory, `${brand}.png`), bytes);
    console.log(`generated ${brand}.png (${width * 2} x ${height * 2})`);
  }
} finally {
  await browser.close();
}
