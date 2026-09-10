import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The SVG is the source of truth. Use the existing browser dependency to render
// deterministic install assets; no image service or extra library is required.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'assets/icons/reportflow-icon.svg'), 'utf8');
const outputs = [
  { file: 'reportflow-192.png', size: 192 },
  { file: 'reportflow-512.png', size: 512 },
  { file: 'reportflow-maskable-512.png', size: 512, fullBleed: true },
  { file: 'reportflow-apple-touch-180.png', size: 180, fullBleed: true }
];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, fullBleed = false } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      svg { display: block; width: 100%; height: 100%; }
    </style></head><body>${source}</body></html>`);
    if (fullBleed) {
      await page.locator('#reportflow-background').evaluate((rectangle) => rectangle.removeAttribute('rx'));
    }
    const bytes = await page.screenshot({ omitBackground: true, animations: 'disabled' });
    assert.equal(bytes.readUInt32BE(16), size, `${file} width`);
    assert.equal(bytes.readUInt32BE(20), size, `${file} height`);
    writeFileSync(resolve(root, 'assets/icons', file), bytes);
    console.log(`generated ${file} (${size} x ${size}${fullBleed ? ', full bleed' : ''})`);
  }
  // Keep the public favicon fallback identical to the canonical vector asset.
  writeFileSync(resolve(root, 'public/favicon.svg'), source);
} finally {
  await browser.close();
}
