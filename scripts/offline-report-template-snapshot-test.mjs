import { reportEmailSelection, reportEmailSelectionStale } from '../assets/js/report-email-recipients.js';
import assert from 'node:assert/strict';
import { createWorkerReportTemplateSnapshotStore } from '../assets/js/offline-report-template-snapshot.js';

function memoryStorage() {
  const values = new Map();
  return {
    get: async (store, key) => structuredClone(values.get(`${store}:${key}`)),
    put: async (store, value) => { values.set(`${store}:${value.key}`, structuredClone(value)); },
    remove: async (store, key) => { values.delete(`${store}:${key}`); }
  };
}

const worker = { id: 12, departmentId: 3, role: 'worker', status: 'active' };
const template = {
  id: 51, department_id: 3, name: 'Site inspection', description: 'Inspect the work area.',
  status: 'active', template_purpose: 'report', definition_version: 2,
  pdf_email_options: { version: 3, enabled: true, recipients: ['approved@example.invalid'], default_recipients: [] },
  fields: [{ id: 'issue', type: 'text', label: 'Issue', required: true }]
};

const snapshots = createWorkerReportTemplateSnapshotStore(memoryStorage());
assert.equal(await snapshots.save(worker, [template]), true);
const restored = await snapshots.load(worker);
assert.deepEqual(restored.templates, [template]);
assert.ok(Number.isFinite(Date.parse(restored.savedAt)));
console.log('ok - a returning Worker can load the exact saved Report Template Definition');

for (const otherUser of [null, { ...worker, id: 99 }, { ...worker, departmentId: 4 },
  { ...worker, role: 'supervisor' }, { ...worker, status: 'resigned' },
  { ...worker, departmentId: null }, { ...worker, id: [] }]) {
  assert.equal(await snapshots.load(otherUser), null);
}
for (const invalidUser of [null, { ...worker, role: 'supervisor' }, { ...worker, status: 'resigned' },
  { ...worker, departmentId: null }, { ...worker, id: [] }]) {
  assert.equal(await snapshots.save(invalidUser, [template]), false);
}
console.log('ok - saved Templates never cross Worker, Department, active-status or role boundaries');

const invalidTemplates = [null, [], { ...template, department_id: 4 },
  { ...template, department_id: undefined }, { ...template, departmentId: 4 },
  { ...template, status: 'archived' }, { ...template, template_purpose: 'daywork' },
  { ...template, template_purpose: undefined }, { ...template, templatePurpose: 'daywork' },
  { ...template, definition_version: 0 }, { ...template, definition_version: undefined },
  { ...template, fields: 'invalid' }, { ...template, fields: [null] },
  { ...template, fields: [{}] }, { ...template, fields: [{ ...template.fields[0], type: 'unknown-schema' }] }];
await snapshots.save(worker, [...invalidTemplates, { ...template, answers: { private: 'not a Template' }, photoUrls: ['private'] }]);
assert.deepEqual((await snapshots.load(worker)).templates, [template]);
await snapshots.save(worker, []);
assert.deepEqual((await snapshots.load(worker)).templates, []);
console.log('ok - only active explicit Department Report Templates are saved; an empty live list replaces old Templates');

const envelope = {
  schemaVersion: 1, ownerWorkerId: '12', departmentId: '3',
  savedAt: '2026-09-15T03:25:00.000Z', templates: [template]
};
for (const invalidEnvelope of [null, { ...envelope, schemaVersion: 2 },
  { ...envelope, ownerWorkerId: '99' }, { ...envelope, departmentId: '4' },
  { ...envelope, savedAt: 'invalid' }, { ...envelope, templates: null }]) {
  const corruptStore = createWorkerReportTemplateSnapshotStore({
    ...memoryStorage(), get: async () => ({ value: invalidEnvelope })
  });
  assert.equal(await corruptStore.load(worker), null);
}
const corruptTemplates = createWorkerReportTemplateSnapshotStore({
  ...memoryStorage(), get: async () => ({ value: { ...envelope, templates: [template, ...invalidTemplates] } })
});
assert.deepEqual((await corruptTemplates.load(worker)).templates, [template]);
console.log('ok - corrupt or mismatched saved envelopes fail closed and every loaded Template is revalidated');

const delayedStorage = memoryStorage();
const writeStarted = Promise.withResolvers();
const finishWrite = Promise.withResolvers();
const orderedSnapshots = createWorkerReportTemplateSnapshotStore({
  ...delayedStorage,
  put: async (...args) => { writeStarted.resolve(); await finishWrite.promise; await delayedStorage.put(...args); }
});
const saving = orderedSnapshots.save(worker, [template]);
await writeStarted.promise;
const clearing = orderedSnapshots.clear(worker);
finishWrite.resolve();
await Promise.all([saving, clearing]);
assert.equal(await orderedSnapshots.load(worker), null);
assert.equal(await orderedSnapshots.save(worker, [template], { isCurrent: () => false }), false);
assert.equal(await orderedSnapshots.load(worker), null);
console.log('ok - logout clearing wins an in-flight save and obsolete sessions cannot repopulate Templates');

const independent = createWorkerReportTemplateSnapshotStore(memoryStorage());
const original = structuredClone(template);
await independent.save(worker, [original]);
original.fields[0].label = 'Changed elsewhere';
const loaded = await independent.load(worker);
loaded.templates[0].fields[0].label = 'Changed in the form';
assert.deepEqual((await independent.load(worker)).templates, [template]);
await independent.save({ ...worker, id: 99 }, [{ ...template, name: 'Other Worker copy' }]);
await independent.clear({ ...worker, role: 'supervisor', status: 'resigned' });
assert.equal(await independent.load(worker), null);
assert.equal((await independent.load({ ...worker, id: 99 })).templates[0].name, 'Other Worker copy');
console.log('ok - editing live objects cannot rewrite stored Definitions; clearing an invalidated scope leaves other Workers untouched');

const failedRemovalStorage = memoryStorage();
const failClosed = createWorkerReportTemplateSnapshotStore({
  ...failedRemovalStorage, remove: async () => { throw new Error('Storage unavailable'); }
});
await failClosed.save(worker, [template]);
await assert.rejects(failClosed.clear(worker), /Storage unavailable/);
assert.equal(await failClosed.load(worker), null);
await failClosed.save(worker, [template]);
assert.deepEqual((await failClosed.load(worker)).templates, [template]);
console.log('ok - a failed clear cannot restore revoked Templates in this session; a new authenticated save may replace them');

const options = template.pdf_email_options;
assert.deepEqual(reportEmailSelection(options, { pdfEmailRecipients: [], expectedPdfEmailVersion: 1 }), { pdfEmailRecipients: [], expectedPdfEmailVersion: 1 });
assert.equal(reportEmailSelectionStale(options, { pdfEmailRecipients: [], expectedPdfEmailVersion: 1 }), false);
assert.equal(reportEmailSelectionStale(null, { pdfEmailRecipients: ['approved@example.invalid'], expectedPdfEmailVersion: 3 }), true);
assert.equal(reportEmailSelectionStale(options, { pdfEmailRecipients: ['approved@example.invalid'], expectedPdfEmailVersion: 2 }), true);
assert.equal(reportEmailSelectionStale(options, { pdfEmailRecipients: ['unapproved@example.invalid'], expectedPdfEmailVersion: 3 }), true);
console.log('ok - explicit self-only survives version changes; stale/unavailable approvals never permit additional copies');

assert.equal(reportEmailSelectionStale(null, { pdfEmailRecipients: [], expectedPdfEmailVersion: 3 }), true, 'Old backend cannot guarantee explicit self-only');
assert.equal(reportEmailSelectionStale(null, {}), false, 'Legacy forms retain legacy flow');

const malformedDirectory = { ...template, pdf_email_options: { source: 'department_users', version: 3, recipients: [], default_recipients: [] } };
await snapshots.save(worker, [malformedDirectory]);
assert.deepEqual((await snapshots.load(worker)).templates[0].pdf_email_options, { unavailable: true }, 'Malformed advertised directory survives offline snapshot without downgrading to legacy absence');
console.log('ok - malformed Department directory remains explicitly unavailable offline');
