import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59977'; // All requests intercepted; no backend or live account.
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const errors = [];
const unexpectedRequests = [];
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin && url.pathname === '/') {
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><main id="review"></main></body></html>' });
  }
  if (url.origin === origin && /^\/assets\/js\/[a-z\d-]+\.js$/.test(url.pathname)) {
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname.slice(1)), 'utf8') });
  }
  unexpectedRequests.push(url.href);
  return route.abort();
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(origin);
  await page.evaluate(async () => {
    const renderer = await import('/assets/js/report-submit-review.js');
    const fields = await import('/assets/js/work-form-fields.js');
    const i18n = await import('/assets/js/i18n.js');
    window.fixture = { ...renderer, ...fields, ...i18n, container: document.getElementById('review') };
    const canvas = document.createElement('canvas');
    canvas.width = 72;
    canvas.height = 22;
    canvas.getContext('2d').fillRect(4, 8, 30, 3);
    window.signature = canvas.toDataURL('image/png');
  });

  const scalars = await page.evaluate(() => {
    const { renderReportSubmitReview, container } = window.fixture;
    const form = { name: '<img src="https://not-allowed.test/template">', fields: [
      { id: 'notes', type: 'textarea', label: '<script>bad field label</script>' },
      { id: 'safe', type: 'checkbox', label: 'Safe to proceed' },
      { id: 'count', type: 'number', label: 'Quantity' },
      { id: 'empty', type: 'text', label: 'Optional details' },
      { id: 'approval', type: 'signature', label: 'Worker signature' }
    ] };
    const answers = { notes: 'Line one\n<img src="https://not-allowed.test/answer" onerror="alert(1)">', safe: false, count: 0, empty: '', approval: window.signature };
    const original = JSON.stringify({ form, answers });
    renderReportSubmitReview(container, { form, answers, workDate: '2026-09-29', siteName: '<svg onload="alert(2)">', photoCount: 50 });
    return {
      text: container.textContent,
      terms: [...container.querySelectorAll('.report-review-answers > .report-review-item > dt')].map((node) => node.textContent),
      descriptions: [...container.querySelectorAll('.report-review-answers > .report-review-item > dd')].map((node) => node.textContent),
      unsafeNodes: container.querySelectorAll('script, svg, [onerror]').length,
      images: [...container.querySelectorAll('img')].map((image) => ({ src: image.getAttribute('src'), alt: image.alt })),
      literalNotes: container.querySelector('.report-review-answers dd').hasAttribute('data-no-i18n'),
      labelsProtected: [...container.querySelectorAll('.report-review-answers dt')].every((node) => node.hasAttribute('data-no-i18n')),
      unchanged: original === JSON.stringify({ form, answers }),
      calculationNotes: container.querySelectorAll('.report-review-calculation-note').length,
      signature: window.signature
    };
  });
  assert.match(scalars.text, /2026-09-29/);
  assert.match(scalars.text, /Photos50/);
  assert.match(scalars.text, /<svg onload="alert\(2\)">/);
  assert.deepEqual(scalars.terms, ['<script>bad field label</script>', 'Safe to proceed', 'Quantity', 'Optional details', 'Worker signature']);
  assert.deepEqual(scalars.descriptions, ['Line one\n<img src="https://not-allowed.test/answer" onerror="alert(1)">', 'No', '0', 'Not provided', 'Signed']);
  assert.equal(scalars.unsafeNodes, 0);
  assert.deepEqual(scalars.images, [{ src: scalars.signature, alt: 'Handwritten signature' }]);
  assert.equal(scalars.literalNotes, true);
  assert.equal(scalars.labelsProtected, true);
  assert.equal(scalars.unchanged, true);
  assert.equal(scalars.calculationNotes, 0);

  const conditional = await page.evaluate(() => {
    const { summarizeWorkFormAnswers, renderReportSubmitReview, container } = window.fixture;
    const form = { name: 'Conditional Report', fields: [
      { id: 'section', type: 'section', label: 'Information' },
      { id: 'outcome', type: 'select', label: 'Outcome' },
      { id: 'hidden', type: 'text', label: 'Failure details', showIf: 'outcome=Fail' },
      { id: 'hidden_followup', type: 'text', label: 'Hidden follow-up', show_if: 'hidden=stale' },
      { id: 'hours', type: 'time-range', label: 'Work time' },
      { id: 'people', type: 'number', label: 'Workers' },
      { id: 'total', type: 'formula', label: 'Worker hours', formula: 'hours * people' },
      { id: 'visible', type: 'text', label: 'Long work note', show_if: 'total>=6' },
      { id: 'hidden_team', type: 'repeat', label: 'Hidden team', show_if: 'outcome=Fail' },
      { id: 'hidden_child', type: 'text', label: 'Hidden name', repeat: 'hidden_team' }
    ] };
    const answers = { outcome: 'Pass', hidden: 'stale', hidden_followup: 'Stale follow-up', hours: { start: '22:00', end: '01:00', duration_hours: 999 }, people: '2', total: 999, visible: 'Check at dawn', hidden_team: [{ hidden_child: 'Not applicable' }] };
    const before = JSON.stringify({ form, answers });
    const summary = summarizeWorkFormAnswers(form, answers);
    renderReportSubmitReview(container, { form, answers, workDate: '2026-09-29', siteName: '', photoCount: 0 });
    return { summary, unchanged: before === JSON.stringify({ form, answers }), text: container.textContent };
  });
  assert.deepEqual(conditional.summary.entries.map((entry) => entry.id), ['outcome', 'hours', 'people', 'total', 'visible']);
  assert.deepEqual(conditional.summary.entries.find((entry) => entry.id === 'hours').value, { start: '22:00', end: '01:00', duration_hours: 3 });
  assert.equal(conditional.summary.entries.find((entry) => entry.id === 'total').value, 6);
  assert.equal(conditional.summary.hasCalculatedValues, true);
  assert.equal(conditional.unchanged, true);
  assert.doesNotMatch(conditional.text, /stale|Hidden|Failure|999/);
  assert.match(conditional.text, /22:00 – 01:00 · 3 hours/);
  assert.match(conditional.text, /No site selected/);
  assert.match(conditional.text, /Calculated values are previews; the server confirms them on submission\./);

  const repeats = await page.evaluate(() => {
    const { renderReportSubmitReview, summarizeWorkFormAnswers, container } = window.fixture;
    const form = { name: 'Witnesses', fields: [
      { id: 'parent_approved', type: 'checkbox', label: 'Include notes' },
      { id: 'people', type: 'repeat', label: 'People on site' },
      { id: 'name', type: 'text', label: 'Full name', repeat: 'people' },
      { id: 'present', type: 'checkbox', label: 'Was present', repeat: 'people' },
      { id: 'hidden', type: 'text', label: 'Absence reason', repeat: 'people', show_if: 'present=false' },
      { id: 'parent_note', type: 'text', label: 'Supervisor note', repeat: 'people', show_if: 'parent_approved=true' },
      { id: 'hours', type: 'time_range', label: 'Shift', repeat: 'people' },
      { id: 'preview', type: 'formula', label: 'Double shift', repeat: 'people', formula: 'hours * 2' },
      { id: 'signature', type: 'signature', label: 'Witness signature', repeat: 'people' },
      { id: 'empty_repeat', type: 'repeat', label: 'Optional materials' },
      { id: 'material', type: 'text', label: 'Material name', repeat: 'empty_repeat' }
    ] };
    const answers = { parent_approved: true, people: [
      { name: 'Ana', present: true, hidden: 'Old absence', parent_note: 'Present at start', hours: { start: '08:00', end: '09:30' }, signature: window.signature },
      { name: 'Bo', present: false, hidden: 'Away', parent_note: '', hours: { start: '', end: '' }, signature: '' }
    ], empty_repeat: [] };
    const before = JSON.stringify(answers);
    const summary = summarizeWorkFormAnswers(form, answers);
    renderReportSubmitReview(container, { form, answers, workDate: '2026-09-29', photoCount: 1 });
    return { summary, text: container.textContent, images: container.querySelectorAll('.report-review-signature img').length,
      labels: [...container.querySelectorAll('.report-review-row-label')].map((node) => node.textContent), unchanged: before === JSON.stringify(answers) };
  });
  const people = repeats.summary.entries.find((entry) => entry.id === 'people');
  assert.deepEqual(people.rows[0].map((entry) => entry.label), ['Full name', 'Was present', 'Supervisor note', 'Shift', 'Double shift', 'Witness signature']);
  assert.equal(people.rows[0].find((entry) => entry.id === 'preview').value, 3);
  assert.equal(people.rows[1].find((entry) => entry.id === 'present').value, false);
  assert.equal(people.rows[1].find((entry) => entry.id === 'hidden').value, 'Away');
  assert.equal(repeats.images, 1);
  assert.deepEqual(repeats.labels, ['Row 1', 'Row 2']);
  assert.doesNotMatch(repeats.text, /Old absence/);
  assert.match(repeats.text, /Optional materialsNot provided/);
  assert.equal(repeats.unchanged, true);

  const invalidSignatures = await page.evaluate(() => {
    const { renderReportSubmitReview, container } = window.fixture;
    const fields = ['remote', 'script', 'svg', 'blob', 'empty'].map((id) => ({ id, label: id, type: 'signature' }));
    renderReportSubmitReview(container, { form: { name: 'Safe signatures', fields }, answers: {
      remote: 'https://not-allowed.test/signature.png', script: 'javascript:alert(1)',
      svg: 'data:image/svg+xml;base64,PHN2Zy8+', blob: 'blob:https://not-allowed.test/id', empty: ''
    }, photoCount: 2 });
    return { text: container.textContent, images: container.querySelectorAll('img').length };
  });
  assert.equal(invalidSignatures.images, 0);
  assert.equal(invalidSignatures.text.match(/Signature preview unavailable/g)?.length, 4);
  assert.match(invalidSignatures.text, /emptyNot provided/);
  assert.doesNotMatch(invalidSignatures.text, /https:|javascript:|base64/);

  const empty = await page.evaluate(() => {
    const { renderReportSubmitReview, container } = window.fixture;
    renderReportSubmitReview(container, { form: { name: 'Photo only', fields: [] }, answers: {}, workDate: '2026-09-29', photoCount: 50 });
    return { text: container.textContent, images: container.querySelectorAll('img').length, calculationNotes: container.querySelectorAll('.report-review-calculation-note').length };
  });
  assert.match(empty.text, /No answers required/);
  assert.match(empty.text, /Photos50/);
  assert.equal(empty.images, 0);
  assert.equal(empty.calculationNotes, 0);

  assert.deepEqual(errors, [], 'No unhandled browser errors');
  assert.deepEqual(unexpectedRequests, [], 'Summary performs no API calls or remote signature requests');
  console.log('Report submission summary checks passed: scalar/hostile text, conditional/time/formula, repeated answers/signatures, unsafe signature rejection, and empty/photo-only Reports.');
} finally {
  await context.close();
  await browser.close();
}
