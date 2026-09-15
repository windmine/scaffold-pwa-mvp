import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59992'; // Fully intercepted; no app server or external requests.
const groupFields = [
  { id: 'group', type: 'repeat', label: 'Original group', min_rows: 0, max_rows: 5 },
  { id: 'answer', type: 'text', label: 'Original answer', repeat: 'group' }
];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'No external requests are permitted');
  if (url.pathname === '/') return route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html lang="en"><body><div id="builder"></div><button id="outside">Outside editor</button></body></html>'
  });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(projectRoot, url.pathname), 'utf8') });
});

async function openBuilder(page, fields = groupFields) {
  await page.goto(origin);
  await page.evaluate(async (initialFields) => {
    const { createWorkFormBuilder } = await import('/assets/js/work-form-builder.js');
    const changes = [];
    const confirmations = [];
    const builder = createWorkFormBuilder(document.querySelector('#builder'), {
      fields: initialFields,
      onChange: (nextFields) => changes.push(nextFields),
      confirmAction: (options) => new Promise((resolve) => confirmations.push({ options, resolve }))
    });
    window.fixture = { builder, changes, confirmations };
  }, fields);
}

async function resolveConfirmation(page, accepted = true) {
  await page.evaluate(async (value) => {
    window.fixture.confirmations.shift().resolve(value);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(requestAnimationFrame);
  }, accepted);
}

try {
  const page = await context.newPage();
  await openBuilder(page);
  await page.locator('[data-field-id="group"] > header [data-remove-work-form-field]').click();
  assert.equal(await page.evaluate(() => window.fixture.confirmations.length), 1);
  const replacement = await page.evaluate(() => {
    window.fixture.builder.reset();
    window.fixture.builder.setFields([
      { id: 'group', type: 'repeat', label: 'Replacement group' },
      { id: 'answer', type: 'text', label: 'Replacement answer', repeat: 'group' }
    ]);
    return { state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length };
  });
  await resolveConfirmation(page);
  assert.deepEqual(await page.evaluate(() => ({
    state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length
  })), replacement);
  console.log('ok - accepting an old group-removal confirmation cannot change a reset/replaced draft');

  await openBuilder(page);
  await page.locator('[data-field-id="group"] > .work-form-field-card-body [data-field-property="type"]').first().selectOption('text');
  assert.equal(await page.evaluate(() => window.fixture.confirmations.length), 1);
  const restored = await page.evaluate(() => {
    const prior = window.fixture.builder.getDraftState();
    window.fixture.builder.restoreDraftState({
      ...prior, rawText: '  invalid | unfinished raw syntax  \n\n', rawDirty: true
    });
    document.querySelector('#outside').focus();
    return { state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length };
  });
  await resolveConfirmation(page);
  assert.deepEqual(await page.evaluate(() => ({
    state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length
  })), restored);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'outside');
  console.log('ok - an old type-change confirmation cannot delete restored children, raw input or focus');

  await openBuilder(page);
  const pendingRaw = await page.evaluate(() => {
    const state = window.fixture.builder.getDraftState();
    window.fixture.builder.restoreDraftState({ ...state, rawText: '\n  select|unfinished|  \n\n', rawDirty: true });
    return { state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length };
  });
  await page.locator('[data-field-id="group"] > .work-form-field-card-body [data-field-property="type"]').first().selectOption('text');
  await resolveConfirmation(page, false);
  assert.deepEqual(await page.evaluate(() => ({
    state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length
  })), pendingRaw);
  assert.equal(await page.locator('[data-field-id="group"] > .work-form-field-card-body [data-field-property="type"]').first().inputValue(), 'repeat');
  console.log('ok - canceling a destructive type change preserves unapplied raw text and does not autosave a false change');

  for (const action of ['remove', 'type']) {
    for (const boundary of ['destroy', 'reset', 'setFields', 'restoreDraftState']) {
      for (const accepted of [true, false]) {
        await openBuilder(page);
        if (action === 'remove') await page.locator('[data-field-id="group"] > header [data-remove-work-form-field]').click();
        else await page.locator('[data-field-id="group"] > .work-form-field-card-body [data-field-property="type"]').first().selectOption('text');
        const afterBoundary = await page.evaluate((operation) => {
          const builder = window.fixture.builder;
          if (operation === 'setFields') builder.setFields(builder.getFields());
          else if (operation === 'restoreDraftState') builder.restoreDraftState(builder.getDraftState());
          else builder[operation]();
          document.querySelector('#outside').focus();
          return { state: builder.getDraftState(), changes: window.fixture.changes.length };
        }, boundary);
        await resolveConfirmation(page, accepted);
        assert.deepEqual(await page.evaluate(() => ({
          state: window.fixture.builder.getDraftState(), changes: window.fixture.changes.length
        })), afterBoundary, `${action}/${boundary}/${accepted}`);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'outside', `${action}/${boundary}/${accepted} focus`);
      }
    }
  }
  console.log('ok - accept/cancel continuations are inert after destroy, reset, setFields and draft restoration');

  await openBuilder(page);
  await page.locator('[data-work-form-advanced]').evaluate((element) => { element.open = true; });
  const rawText = '\n  unsupported|未完成 Report field|true| A, B  \n>text|\n\n';
  await page.locator('[data-work-form-raw]').fill(rawText);
  const captured = await page.evaluate(() => window.fixture.builder.getDraftState());
  assert.equal(captured.rawText, rawText);
  assert.equal(captured.rawDirty, true);
  assert.equal(await page.evaluate(() => window.fixture.builder.validate()), false);
  assert.equal(await page.evaluate(() => window.fixture.builder.applyRaw()), false);
  assert.equal(await page.locator('[data-work-form-raw]').inputValue(), rawText);
  await page.evaluate((state) => {
    window.fixture.builder.reset();
    window.fixture.builder.restoreDraftState(state);
  }, captured);
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getDraftState()), captured);
  assert.equal(await page.locator('[data-work-form-raw]').inputValue(), rawText);
  assert.equal(await page.locator('[data-work-form-raw]').getAttribute('aria-invalid'), null);
  const beforeDiscard = await page.evaluate(() => window.fixture.changes.length);
  await page.evaluate(() => window.fixture.builder.discardRaw());
  assert.equal(await page.evaluate(() => window.fixture.builder.hasPendingRawChanges()), false);
  assert.equal(await page.evaluate(() => window.fixture.changes.length), beforeDiscard + 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getFields()), captured.fields);
  console.log('ok - invalid unapplied Unicode/raw whitespace round-trips exactly and discard notifies autosave');

  await openBuilder(page);
  await page.locator('[data-field-id="group"] > .work-form-field-card-body [data-field-property="type"]').first().selectOption('text');
  assert.equal(await page.evaluate(() => window.fixture.changes.length), 0);
  await resolveConfirmation(page, true);
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getFields().map(({ id, type }) => ({ id, type }))), [{ id: 'group', type: 'text' }]);
  assert.equal(await page.evaluate(() => window.fixture.changes.length), 1);
  await page.locator('[data-field-id="group"] [data-field-property="required"]').check();
  assert.equal(await page.evaluate(() => window.fixture.builder.getFields()[0].required), true);
  await openBuilder(page);
  await page.locator('[data-field-id="group"] > header [data-remove-work-form-field]').click();
  await resolveConfirmation(page, true);
  assert.deepEqual(await page.evaluate(() => window.fixture.builder.getFields()), []);
  assert.equal(await page.evaluate(() => window.fixture.changes.length), 1);
  console.log('ok - current confirmed type/removal changes and ordinary required-field editing still work');

  await openBuilder(page, [{ id: 'answer', type: 'text', label: 'Old private field' }]);
  const announcement = await page.evaluate(async () => {
    document.querySelector('[data-remove-work-form-field]').click();
    window.fixture.builder.reset();
    const node = document.querySelector('[data-work-form-builder-announcement]');
    node.textContent = 'Current editor';
    await new Promise(requestAnimationFrame);
    return node.textContent;
  });
  assert.equal(announcement, 'Current editor');
  console.log('ok - deferred announcements cannot reintroduce old field labels after reset');
} finally {
  await context.close();
  await browser.close();
}
