import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The real Template builder, validation, language and CSS run in an isolated
// browser. Every request is intercepted; no backend, accounts or hosted writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59960';
const output = path.join(root, 'output', 'report-template-simplicity.local');
const simpleFields = [
  { id: 'area', type: 'text', label: 'Area inspected', required: true },
  { id: 'clear', type: 'checkbox', label: 'Access route clear' }
];
const advancedFields = [
  { id: 'hours', type: 'number', label: 'Hours checked', required: true },
  { id: 'total', type: 'formula', label: 'Calculated total', formula: 'hours * 2' },
  { id: 'detail', type: 'textarea', label: 'Additional information', show_if: 'hours>0' },
  { id: 'checks', type: 'repeat', label: 'Inspection points', min_rows: 0, max_rows: 4 },
  { id: 'point', type: 'text', label: 'Point description', repeat: 'checks' }
];
const rawAdvanced = 'number|Hours checked|required||id=hours\nformula|Calculated total||hours * 2|id=total\ntextarea|Additional information|||id=detail;show_if=hours>0';
const rawUnapplied = '\n  unsupported|未完成 Report field|true| A, B  \n>text|\n\n';
const markup = `<!doctype html><html lang="en-NZ" data-theme="light"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <style>main{width:100%;max-width:950px;margin:0 auto;padding:12px;box-sizing:border-box}</style>
  </head><body class="report-only-mode"><main><h1>Report Template</h1>
  <div id="builder"></div><button id="outside">Outside editor</button>
  <button id="languageToggle" data-language-toggle hidden>中文</button></main></body></html>`;

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
context.setDefaultTimeout(7000);
const errors = [];
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'Template simplicity tests cannot access external services');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  assert.match(url.pathname, /^\/assets\/(?:js\/[a-z\d-]+\.js|css\/styles\.css)$/);
  return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
const builder = page.locator('#builder');
const toggle = builder.locator('[data-work-form-advanced-options]');
const field = (id) => builder.locator(`[data-field-id="${id}"]`);
const property = (id, name) => field(id).locator(`:scope > .work-form-field-card-body [data-field-property="${name}"]`).first();

async function mount(fields = simpleFields, reportOnly = true) {
  await page.goto(origin);
  await page.evaluate(async (options) => {
    const { createWorkFormBuilder } = await import('/assets/js/work-form-builder.js');
    const { initLanguageToggle } = await import('/assets/js/i18n.js');
    initLanguageToggle({ button: document.querySelector('#languageToggle') });
    const changes = [], confirmations = [];
    const instance = createWorkFormBuilder(document.querySelector('#builder'), {
      fields: options.fields, reportOnly: options.reportOnly,
      onChange: (nextFields) => changes.push(nextFields),
      confirmAction: (request) => new Promise((resolve) => confirmations.push({ request, resolve }))
    });
    document.body.classList.toggle('report-only-mode', options.reportOnly);
    window.fixture = { builder: instance, changes, confirmations };
  }, { fields, reportOnly });
}

async function state() {
  return page.evaluate(() => ({ draft: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length }));
}

async function visibleCount(selector) {
  return builder.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').length);
}

async function setChecked(control, checked) {
  if (await control.isChecked() !== checked) await control.locator('..').click();
  assert.equal(await control.isChecked(), checked);
}

async function resolveConfirmation(accepted) {
  await page.evaluate(async (value) => {
    window.fixture.confirmations.shift().resolve(value);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(requestAnimationFrame);
  }, accepted);
}

try {
  await mount();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await builder.getByRole('checkbox', { name: 'Show advanced field options', exact: true }).count(), 1);
  assert.equal(await visibleCount('.work-form-field-key'), 0);
  assert.equal(await visibleCount('[data-field-property="condition-enabled"]'), 0);
  assert.equal(await builder.locator('[data-field-property="type"] option[value="formula"]').count(), 0);
  assert.equal(await builder.locator('[data-field-property="type"] option[value="repeat"]').count(), 0);
  assert.equal(await property('area', 'required').isChecked(), true);
  assert.equal(await property('area', 'label').inputValue(), 'Area inspected');
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), true);
  console.log('ok - Report Templates default to simple fields, accessible advanced toggle off, no keys/conditions/new formula or group choices, with required answers intact');

  const beforeToggle = await state();
  await toggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await toggle.evaluate((node) => node === document.activeElement), true);
  assert.equal(await visibleCount('.work-form-field-key'), 2);
  assert.equal(await visibleCount('[data-field-property="condition-enabled"]'), 2);
  assert.equal(await property('area', 'type').locator('option[value="formula"]').count(), 1);
  assert.equal(await property('area', 'type').locator('option[value="repeat"]').count(), 1);
  assert.deepEqual(await state(), beforeToggle);
  await builder.locator('[data-work-form-advanced] > summary').click();
  await builder.locator('[data-work-form-raw]').fill(rawUnapplied);
  const pending = await state();
  await setChecked(toggle, false);
  await setChecked(toggle, true);
  assert.deepEqual(await state(), pending);
  assert.equal(await builder.locator('[data-work-form-raw]').inputValue(), rawUnapplied);
  assert.equal(await page.evaluate(() => window.fixture.builder.hasPendingRawChanges()), true);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), false);
  assert.equal(await page.evaluate(() => window.fixture.builder.applyRaw()), false);
  assert.deepEqual((await state()).draft, pending.draft);
  assert.deepEqual(Object.keys(pending.draft).sort(), ['fields', 'rawDirty', 'rawText']);
  console.log('ok - keyboard/view toggles retain focus and never mutate fields, autosave count, generated keys or exact unapplied raw syntax');

  for (const fields of [
    advancedFields.slice(0, 2), advancedFields.slice(3),
    [advancedFields[0], advancedFields[2]]
  ]) {
    await mount(fields);
    assert.equal(await toggle.isChecked(), true);
    const original = await state();
    await setChecked(toggle, false);
    assert.deepEqual(await state(), original);
    assert.equal(await visibleCount('.work-form-field-key'), 0);
    for (const item of fields) {
      assert.equal(await property(item.id, 'type').inputValue(), item.type);
      if (item.type === 'formula') {
        assert.equal(await property(item.id, 'formula').isVisible(), true);
        assert.equal(await property(item.id, 'formula').inputValue(), item.formula);
      }
      if (item.type === 'repeat') {
        assert.equal(await property(item.id, 'min-rows').isVisible(), true);
        assert.equal(await property(item.id, 'max-rows').inputValue(), String(item.max_rows));
        assert.equal(await field(item.id).locator('[data-repeat-field-list] [data-work-form-field-card]').count(), 1);
      }
      if (item.show_if) assert.equal(await property(item.id, 'condition-enabled').isChecked(), true);
    }
    assert.equal(await page.evaluate(() => window.fixture.builder.validate()), true);
  }
  console.log('ok - existing formula, repeating-group and conditional fields auto-enable advanced view and retain their configured controls/data when it is switched off');

  await mount();
  for (const operation of ['setFields', 'restoreDraftState']) {
    await page.evaluate(({ method, fields }) => {
      const instance = window.fixture.builder;
      if (method === 'setFields') instance.setFields(fields);
      else instance.restoreDraftState({ fields, rawText: '', rawDirty: false });
    }, { method: operation, fields: advancedFields });
    assert.equal(await toggle.isChecked(), true);
    const existing = await state();
    await setChecked(toggle, false);
    assert.deepEqual(await state(), existing);
    await page.evaluate(({ method, fields }) => {
      const instance = window.fixture.builder;
      if (method === 'setFields') instance.setFields(fields);
      else instance.restoreDraftState({ fields, rawText: '', rawDirty: false });
    }, { method: operation, fields: simpleFields });
    assert.equal(await toggle.isChecked(), false);
  }
  await page.evaluate(({ fields, rawText }) => window.fixture.builder.restoreDraftState({ fields, rawText, rawDirty: true }),
    { fields: advancedFields, rawText: rawUnapplied });
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await builder.locator('[data-work-form-raw]').inputValue(), rawUnapplied);
  assert.equal(await builder.locator('[data-work-form-advanced]').getAttribute('open'), '');
  const restored = await state();
  await setChecked(toggle, false);
  assert.deepEqual(await state(), restored);
  console.log('ok - setFields and draft restoration derive visibility from configured fields without persisting view state or rewriting an unapplied raw draft');

  await mount();
  await builder.locator('[data-work-form-advanced] > summary').click();
  await builder.locator('[data-work-form-raw]').fill(rawAdvanced);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.evaluate(() => window.fixture.builder.applyRaw()), true);
  assert.equal(await toggle.isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getFields().map(({ id, type, formula, show_if }) => ({ id, type, formula, show_if }))), [
    { id: 'hours', type: 'number', formula: '', show_if: '' },
    { id: 'total', type: 'formula', formula: 'hours * 2', show_if: '' },
    { id: 'detail', type: 'textarea', formula: '', show_if: 'hours>0' }
  ]);
  assert.equal(await page.evaluate(() => window.fixture.builder.hasPendingRawChanges()), false);
  const applied = await state();
  await setChecked(toggle, false);
  assert.deepEqual(await state(), applied);
  console.log('ok - successful raw apply preserves exact IDs/formula/condition and automatically reveals configured advanced behavior');

  await mount([{ id: 'field_1', type: 'text', label: 'First' }, { id: 'field_3', type: 'text', label: 'Third' }]);
  await builder.locator('.work-form-builder-toolbar [data-add-work-form-field]').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getFields().map(({ id }) => id)), ['field_1', 'field_3', 'field_2']);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate({ focus: true })), false);
  assert.equal(await property('field_2', 'label').getAttribute('aria-invalid'), 'true');
  assert.equal(await property('field_2', 'label').evaluate((node) => node === document.activeElement), true);
  const invalidState = await state();
  const validationMessage = await field('field_2').locator('[data-work-form-field-error]').innerText();
  for (const checked of [true, false]) {
    await setChecked(toggle, checked);
    assert.equal(await field('field_2').locator('[data-work-form-field-error]').isVisible(), true);
    assert.equal(await field('field_2').locator('[data-work-form-field-error]').innerText(), validationMessage);
    assert.equal(await property('field_2', 'label').getAttribute('aria-invalid'), 'true');
    assert.match(await field('field_2').getAttribute('class'), /has-error/);
    assert.deepEqual(await state(), invalidState);
  }
  await property('field_2', 'label').fill('New answer');
  await setChecked(property('field_2', 'required'), true);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), true);
  await setChecked(toggle, true);
  assert.equal(await field('field_2').locator('.work-form-field-key code').textContent(), 'field_2');
  await setChecked(property('field_2', 'condition-enabled'), true);
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields().at(-1).show_if), 'field_1=');
  await property('field_2', 'condition-value').fill('Ready');
  await setChecked(toggle, false);
  assert.equal(await property('field_2', 'condition-enabled').isVisible(), true);
  assert.equal(await property('field_2', 'condition-value').inputValue(), 'Ready');
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields().at(-1).show_if), 'field_1=Ready');
  await property('field_2', 'condition-enabled').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields().at(-1).show_if), '');
  assert.equal(await field('field_2').locator('[data-field-property="condition-enabled"]').count(), 0);
  assert.equal(await property('field_2', 'label').evaluate((node) => node === document.activeElement), true,
    'Removing the last condition in simple view must return keyboard focus to the same card label');
  await mount([
    advancedFields[0],
    { ...advancedFields[3], show_if: 'hours>0' },
    { ...advancedFields[4], show_if: 'hours>1' }
  ]);
  await setChecked(toggle, false);
  await property('checks', 'condition-enabled').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields().find(({ id }) => id === 'checks').show_if), '');
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields().find(({ id }) => id === 'point').show_if), 'hours>1');
  assert.equal(await property('point', 'condition-enabled').isChecked(), true);
  assert.equal(await field('checks').locator(':scope > .work-form-field-card-body > .work-form-condition').count(), 0);
  assert.equal(await property('checks', 'label').evaluate((node) => node === document.activeElement), true,
    'Removing a group condition in simple view must focus its own label, not a remaining child condition');
  console.log('ok - simple Add field retains collision-free IDs, validation/focus/errors through view toggles and required editing; configured conditions remain editable');

  await mount(advancedFields);
  await setChecked(toggle, false);
  const beforeDependency = await state();
  await field('total').locator(':scope > header [data-move-field="up"]').click();
  assert.deepEqual(await state(), beforeDependency);
  assert.match(await builder.locator('[data-work-form-builder-feedback]').textContent(), /Could not move field.*must come after/s);
  await field('hours').locator(':scope > header [data-remove-work-form-field]').click();
  assert.deepEqual(await state(), beforeDependency);
  assert.match(await builder.locator('[data-work-form-builder-feedback]').textContent(), /Could not remove field.*must come after/s);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), true);
  console.log('ok - hiding technical choices does not bypass formula/condition dependency protections for reorder or source-field removal');

  for (const operation of ['type', 'remove']) {
    await mount(advancedFields.slice(3));
    await setChecked(toggle, false);
    const before = await state();
    const begin = async () => {
      if (operation === 'type') await property('checks', 'type').selectOption('text');
      else await field('checks').locator(':scope > header [data-remove-work-form-field]').click();
    };
    await begin();
    assert.equal(await page.evaluate(() => window.fixture.confirmations.length), 1);
    assert.deepEqual(await state(), before);
    await resolveConfirmation(false);
    assert.deepEqual(await state(), before);
    assert.equal(await property('checks', 'type').inputValue(), 'repeat');
    await begin();
    await resolveConfirmation(true);
    const remaining = await page.evaluate(() => window.fixture.builder.getFields().map(({ id, type }) => ({ id, type })));
    assert.deepEqual(remaining, operation === 'type' ? [{ id: 'checks', type: 'text' }] : []);
    assert.equal((await state()).changes, before.changes + 1);
  }
  console.log('ok - existing groups remain rendered while advanced view is off; destructive type/removal requires confirmation, cancel preserves data and accept applies exactly once');

  await mount(advancedFields.slice(3));
  await field('checks').locator(':scope > header [data-remove-work-form-field]').click();
  await page.evaluate(() => { window.fixture.builder.reset(); document.querySelector('#outside').focus(); });
  assert.equal(await toggle.isChecked(), false);
  const reset = await state();
  await resolveConfirmation(true);
  assert.deepEqual(await state(), reset);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'outside');
  await page.evaluate((fields) => window.fixture.builder.setFields(fields), simpleFields);
  await setChecked(toggle, true);
  await page.evaluate(() => {
    window.fixture.detachedToggle = document.querySelector('[data-work-form-advanced-options]');
    window.fixture.builder.destroy();
  });
  await page.evaluate(async (fields) => {
    const { createWorkFormBuilder } = await import('/assets/js/work-form-builder.js');
    window.fixture.builder = createWorkFormBuilder(document.querySelector('#builder'), { fields, reportOnly: true });
    window.fixture.detachedToggle.dispatchEvent(new Event('change', { bubbles: true }));
  }, simpleFields);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await visibleCount('.work-form-field-key'), 0);
  const beforeDisabled = await state();
  const disabledGuard = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#builder input, #builder select, #builder textarea, #builder button')];
    controls.forEach((node) => { node.disabled = true; });
    const advanced = document.querySelector('[data-work-form-advanced-options]');
    advanced.checked = true;
    advanced.dispatchEvent(new Event('change', { bubbles: true }));
    const after = [...document.querySelectorAll('#builder input, #builder select, #builder textarea, #builder button')];
    return { sameNodes: after.length === controls.length && after.every((node, index) => node === controls[index]),
      allDisabled: after.every((node) => node.disabled) };
  });
  assert.deepEqual(disabledGuard, { sameNodes: true, allDisabled: true });
  assert.equal(await visibleCount('.work-form-field-key'), 0);
  assert.deepEqual(await state(), beforeDisabled);
  console.log('ok - reset/new editors restore simple defaults; stale confirmations/toggles stay inert and a disabled toggle cannot redraw or re-enable locked editing controls');

  await mount(simpleFields, false);
  assert.equal(await builder.locator('[data-work-form-advanced-options-control]').isVisible(), false);
  assert.equal(await visibleCount('.work-form-field-key'), 2);
  assert.equal(await visibleCount('[data-field-property="condition-enabled"]'), 2);
  assert.equal(await property('area', 'type').locator('option[value="formula"]').count(), 1);
  assert.equal(await property('area', 'type').locator('option[value="repeat"]').count(), 1);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), true);
  console.log('ok - retained full-interface builders keep all field types, keys, conditions and validation without exposing the report-only toggle');

  let screenshots = 0;
  for (const { width, language, theme } of [
    { width: 320, language: 'en', theme: 'light' },
    { width: 390, language: 'zh', theme: 'dark' }
  ]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [mode, fields] of [['simple', simpleFields], ['advanced', advancedFields.slice(0, 3)]]) {
      await mount(fields);
      await page.evaluate(async ({ nextLanguage, nextTheme }) => {
        document.documentElement.dataset.theme = nextTheme;
        (await import('/assets/js/i18n.js')).setLanguage(nextLanguage);
      }, { nextLanguage: language, nextTheme: theme });
      assert.equal(await toggle.isChecked(), mode === 'advanced');
      const control = builder.locator('[data-work-form-advanced-options-control]');
      if (language === 'zh') assert.doesNotMatch(await control.innerText(), /Show advanced field options/);
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, 'Advanced view control needs a 44px touch target');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${language}/${mode}: horizontal overflow`);
      assert.equal(await visibleCount('.work-form-field-key'), mode === 'advanced' ? fields.length : 0);
      await builder.screenshot({ path: path.join(output, `${mode}-${width}-${language}-${theme}.png`) });
      screenshots += 1;
    }
  }
  assert.equal(screenshots, 4);
  assert.deepEqual(errors, []);
  console.log('ok - four EN320/light and ZH390/dark simple/configured-advanced layouts translate the new control, retain 44px targets and avoid horizontal overflow');
  console.log(`Report Template simplicity screenshots: ${output}`);
} finally {
  await context.close();
  await browser.close();
}
