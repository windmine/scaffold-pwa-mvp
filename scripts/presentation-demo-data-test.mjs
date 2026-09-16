import assert from 'node:assert/strict';
import { DEMO_DESCRIPTION, WORKERS, presentationDataset } from './presentation-demo-data.mjs';

const runId = '20260916-demo-test';
const dataset = presentationDataset(runId, '2026-09-16');
assert.equal(dataset.templates.length, 3);
assert.equal(dataset.sites.length, 2);
assert.equal(dataset.reports.length, 9);
assert.equal(WORKERS.length, 3);
assert.ok(DEMO_DESCRIPTION.includes('Fictional'));
assert.ok(DEMO_DESCRIPTION.includes('Not an operational record'));
assert.equal(new Set(dataset.reports.map((report) => report.key)).size, 9);
for (const worker of WORKERS) assert.ok(worker.name.includes('DEMO'));
for (const entry of [...dataset.templates, ...dataset.sites]) {
  assert.ok(entry.name.includes('DEMO'));
  assert.ok(entry.name.includes(runId));
}
for (const site of dataset.sites) {
  assert.ok(site.address.includes('Fictional'));
  assert.equal(site.latitude, 0);
  assert.ok(site.longitude >= 0 && site.longitude <= 0.001);
  assert.equal(site.allowed_radius_m, 100);
}
for (const workflow of ['submitted', 'in_review', 'resolved']) {
  assert.equal(dataset.reports.filter((report) => report.workflow === workflow).length, 3);
}
for (const template of dataset.templates) {
  assert.equal(template.description, DEMO_DESCRIPTION);
  assert.equal(dataset.reports.filter((report) => report.templateKey === template.key).length, 3);
  assert.equal(new Set(template.fields.map((field) => field.id)).size, template.fields.length);
}
assert.deepEqual([...new Set(dataset.reports.map((report) => report.workDate))].sort(), ['2026-09-14', '2026-09-15', '2026-09-16']);
assert.equal(dataset.reports.filter((report) => report.siteKey === null).length, 2);
assert.ok(dataset.reports.some((report) => report.includePhoto));
assert.ok(dataset.reports.some((report) => !report.includePhoto));
const expectedKeywords = ['walkway', 'delivery', 'weather', 'labels', 'cable', 'packaging', 'northbay', 'inventory', 'handover'];
for (const [index, report] of dataset.reports.entries()) {
  const template = dataset.templates.find((item) => item.key === report.templateKey);
  assert.ok(template);
  assert.ok(WORKERS.some((worker) => worker.key === report.workerKey));
  assert.ok(report.siteKey === null || dataset.sites.some((site) => site.key === report.siteKey));
  assert.equal(typeof report.includePhoto, 'boolean');
  assert.equal(Boolean(report.finalNote), report.workflow === 'resolved');
  if (report.finalNote) assert.ok(report.finalNote.startsWith('DEMO'));
  const serializedAnswers = JSON.stringify(report.answers);
  assert.ok(serializedAnswers.includes('DEMO'));
  assert.ok(serializedAnswers.includes('__DEMO_SIGNATURE__'));
  assert.ok(serializedAnswers.toLowerCase().includes(expectedKeywords[index]));
  for (const field of template.fields) {
    const values = field.repeat ? report.answers[field.repeat].map((row) => row[field.id]) : [report.answers[field.id]];
    for (const value of values) {
      if (field.required) assert.ok(value !== undefined && value !== null && value !== '', `${report.key}: ${field.id}`);
      if (field.type === 'signature' && value) assert.equal(value, '__DEMO_SIGNATURE__');
      if (field.type === 'select' && value) assert.ok(field.options.includes(value));
      if (field.type === 'number' && value !== undefined) assert.equal(typeof value, 'number');
    }
    if (field.type === 'repeat') {
      assert.ok(Array.isArray(report.answers[field.id]));
      assert.ok(report.answers[field.id].length >= field.min_rows);
      assert.ok(report.answers[field.id].length <= field.max_rows);
    }
  }
}
const serialized = JSON.stringify({ WORKERS, dataset });
assert.doesNotMatch(serialized, /https?:\/\/|@|password|token|credential|Kevin|Naylor/i);
assert.doesNotMatch(serialized, /"(?:template|submission)_purpose":"daywork"/);
assert.deepEqual(presentationDataset(runId, '2026-09-16'), dataset);
dataset.templates[0].fields[0].label = 'Changed only in this copy';
assert.equal(presentationDataset(runId, '2026-09-16').templates[0].fields[0].label, 'Meeting details');
assert.equal(presentationDataset(runId, '2026-03-01').reports[0].workDate, '2026-02-27');
assert.equal(presentationDataset(runId, '2028-03-01').reports[1].workDate, '2028-02-29');
for (const invalid of ['2026-02-30', '2026-9-16', 'not-a-date', '', null]) {
  assert.throws(() => presentationDataset(runId, invalid), /anchor date/);
}
for (const invalid of ['', '../demo', 'demo name', 'x'.repeat(49), null]) {
  assert.throws(() => presentationDataset(invalid, '2026-09-16'), /run ID/);
}
console.log('ok - synthetic presentation fixtures: 3 Templates, 3 Workers, 9 Reports, balanced workflow, safe evidence placeholders and validated dates');
