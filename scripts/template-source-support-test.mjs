import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'docs/templates/mutual-source-templates.json'), 'utf8'));
const origin = 'http://127.0.0.1:59991';
const destination = path.join(root, 'output/report-template-preparation-20261022/browser');
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external request or map/geolocation service is permitted');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"></head>
      <body><main style="max-width:800px;margin:auto;padding:16px"><h1>Synthetic blank template preview</h1>
      <div id="builder"></div><form><div id="fields" class="dynamic-fields"></div></form></main></body></html>` });
    assert.match(url.pathname, /^\/assets\/(js|css|icons)\/[a-z\d./-]+$/i);
    const file = path.resolve(root, `.${url.pathname}`);
    assert.ok(file.startsWith(path.join(root, 'assets') + path.sep));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: await readFile(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => {
    window.geoCalls = [];
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: (success, failure, options) => window.geoCalls.push({ success, failure, options }) } });
  });
  for (const template of catalog.templates) {
    await page.evaluate(async (form) => {
      window.fieldsModule = await import('/assets/js/work-form-fields.js');
      window.evidenceModule = await import('/assets/js/work-form-evidence-fields.js');
      const { validateWorkFormBuilderFields } = await import('/assets/js/work-form-builder.js');
      if (!validateWorkFormBuilderFields(form.fields).valid) throw new Error('Invalid source template');
      window.form = form;
      window.photos = [];
      window.options = { container: document.getElementById('fields'), onPhotoChange: (event) => {
        const field = form.fields.find((item) => item.id === event.target.dataset.fieldPhotos);
        window.photos.push(...[...event.target.files].map((file) => ({ field_id: field.id, field_label: window.evidenceModule.photoFieldLabel(field, form.fields), name: file.name })));
        event.target.value = '';
        window.evidenceModule.refreshPhotoFieldCounts(window.options.container, window.photos);
      } };
      window.fieldsModule.renderWorkFormFields(window.options.container, form, window.options);
    }, template.payload);
    assert.equal(await page.locator('[data-work-form-field]').count(), template.payload.fields.length);
    assert.equal(await page.evaluate(() => window.geoCalls.length), 0, 'Rendering never asks for location');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${template.id} mobile overflow`);
    const answers = await page.evaluate(() => window.fieldsModule.collectWorkFormAnswers(window.form, window.options));
    assert.ok(Object.values(answers).every((value) => value === ''), `${template.id} starts blank`);
    for (const field of template.payload.fields.filter((item) => item.description)) {
      assert.equal(await page.locator(`[data-work-form-field="${field.id}"] .work-form-static-instructions`).textContent(), field.description);
      assert.ok(!(field.id in answers));
    }
    const marker = template.payload.fields.find((field) => field.type === 'photos');
    await page.locator(`[data-field-photos="${marker.id}"]`).setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    assert.equal(await page.locator(`[data-field-photo-count="${marker.id}"]`).getAttribute('data-photo-count'), '1');
    assert.equal(await page.evaluate(() => window.photos[0].field_id), marker.id);
    assert.ok(await page.evaluate(() => window.photos[0].field_label.includes(':')));
    await page.screenshot({ path: path.join(destination, `${template.id}-mobile-bottom.png`) });
    if (template.id === 'fm15') {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(destination, 'fm15-mobile-top.png') });
      await page.locator('[data-work-form-field]').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(destination, 'fm15-mobile-end.png') });
    }
  }
  const excavator = catalog.templates.find((item) => item.id === 'excavator').payload;
  await page.evaluate((form) => {
    window.form = form;
    window.fieldsModule.renderWorkFormFields(window.options.container, form, window.options);
  }, excavator);
  const locationId = excavator.fields.find((field) => field.type === 'location').id;
  await page.getByRole('button', { name: 'Capture location', exact: true }).click();
  assert.equal(await page.evaluate(() => window.geoCalls.length), 1);
  await page.evaluate(() => window.geoCalls[0].success({ coords: { latitude: 0, longitude: 0, accuracy: 5 }, timestamp: Date.UTC(2026, 0, 1) }));
  const value = await page.evaluate((id) => window.fieldsModule.collectWorkFormAnswers(window.form, window.options)[id], locationId);
  assert.deepEqual(value, { latitude: 0, longitude: 0, accuracy: 5, captured_at: '2026-01-01T00:00:00.000Z' });
  assert.match(await page.locator('[data-location-map]').getAttribute('href'), /mlat=0&mlon=0/);
  await page.evaluate((answers) => {
    window.fieldsModule.renderWorkFormFields(window.options.container, window.form, window.options);
    window.fieldsModule.populateWorkFormAnswers(window.form, JSON.parse(JSON.stringify(answers)), window.options);
  }, { [locationId]: value });
  assert.deepEqual(await page.evaluate((id) => window.fieldsModule.collectWorkFormAnswers(window.form, window.options)[id], locationId), value);
  await page.getByRole('button', { name: 'Capture location', exact: true }).click();
  await page.getByRole('button', { name: 'Clear location', exact: true }).click();
  await page.evaluate(() => window.geoCalls[1].success({ coords: { latitude: 1, longitude: 1, accuracy: 5 }, timestamp: Date.UTC(2026, 0, 1) }));
  assert.equal(await page.evaluate((id) => window.fieldsModule.collectWorkFormAnswers(window.form, window.options)[id], locationId), '');
  await page.getByRole('button', { name: 'Capture location', exact: true }).click();
  await page.evaluate(() => window.fieldsModule.renderWorkFormFields(window.options.container, window.form, window.options));
  await page.evaluate(() => window.geoCalls[2].success({ coords: { latitude: 1, longitude: 1, accuracy: 5 }, timestamp: Date.UTC(2026, 0, 1) }));
  assert.equal(await page.evaluate((id) => window.fieldsModule.collectWorkFormAnswers(window.form, window.options)[id], locationId), '');
  await page.getByRole('button', { name: 'Capture location', exact: true }).click();
  await page.evaluate(() => window.geoCalls[3].failure({ code: 1 }));
  assert.match(await page.locator('[data-location-status]').textContent(), /Could not capture/);
  console.log('ok - six source templates render completely at 390px with blank answers, independent signatures, static instructions and associated photos');
  console.log('ok - only explicit mocked location requests; coordinate/map/draft roundtrip, denial and stale-result guards pass');
  const instructions = 'Exact static text | 100%; = <unsafe>\n\n第二段';
  const raw = await page.evaluate(async (description) => {
    const form = [{ id: 'static', type: 'section', label: 'Instructions', description }];
    return window.fieldsModule.parseWorkFormFieldsInput(window.fieldsModule.serialiseWorkFormFields(form));
  }, instructions);
  assert.equal(raw[0].description, instructions);
  await page.evaluate(async () => {
    const { createWorkFormBuilder } = await import('/assets/js/work-form-builder.js');
    window.builder = createWorkFormBuilder(document.getElementById('builder'), { fields: [{ id: 'static', type: 'section', label: 'Instructions' }] });
    const input = document.querySelector('[data-work-form-raw]');
    input.value = 'section|Instructions|||description=%ZZ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.builder.applyRaw()), false);
  assert.deepEqual(errors, []);
  console.log('ok - multiline static instructions roundtrip delimiters/Unicode literally and malformed raw edits leave the draft intact');
} finally {
  await browser.close();
}
