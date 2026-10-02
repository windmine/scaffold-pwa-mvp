import assert from 'node:assert/strict';
import { isReportDraftForWorker, reportDraftKeyForWorker, summarizeReportDrafts } from '../assets/js/report-drafts.js';

const worker = { id: 12, role: 'worker', departmentId: 3 };
const template = {
  id: 51, name: 'Site inspection', status: 'active', department_id: 3,
  template_purpose: 'report', definition_version: 2
};
const value = {
  kind: 'work-form', schemaVersion: 1, ownerWorkerId: 12, departmentId: 3,
  templatePurpose: 'report', formId: 51, formName: 'Site inspection',
  definitionVersion: 2, fields: [], workDate: '2026-09-15',
  savedAt: '2026-09-15T03:25:00.000Z', answers: { private: 'Private answer' },
  photoDataUrls: ['data:image/png;base64,private'], photoMetadata: []
};
const entry = { key: 'work-form-draft:12:51', value, updatedAt: value.savedAt };

assert.deepEqual(summarizeReportDrafts([entry], worker, [template]), [{
  draftKey: entry.key, recovered: false,
  formId: 51, formName: 'Site inspection', workDate: '2026-09-15',
  savedAt: value.savedAt, availability: 'editable'
}]);
console.log('ok - current Worker sees only draft metadata, not answers or evidence');

for (const privateEntry of [
  { ...entry, key: 'work-form-draft:99:51' },
  { ...entry, value: { ...value, ownerWorkerId: 99 } },
  { ...entry, value: { ...value, departmentId: 4 } },
  { ...entry, key: 'work-form-draft:12:52' }
]) {
  assert.deepEqual(summarizeReportDrafts([privateEntry], worker, [template]), []);
}
for (const otherSession of [null, { ...worker, role: 'supervisor' }, { ...worker, id: 99 },
  { ...worker, departmentId: 4 }, { ...worker, departmentId: null }]) {
  assert.deepEqual(summarizeReportDrafts([entry], otherSession, [template]), []);
}
console.log('ok - ordinary drafts remain isolated by exact key, Worker and Department');

for (const invalidValue of [null, [], 'draft', 17,
  { ...value, kind: 'submitted-draft-tombstone' },
  { ...value, kind: 'attendance' },
  { ...value, schemaVersion: 2 },
  { ...value, schemaVersion: '1' },
  { ...value, schemaVersion: undefined },
  { ...value, isDraftRecovery: true },
  { ...value, templatePurpose: 'daywork' },
  { ...value, templatePurpose: 'unknown' },
  { ...value, ownerWorkerId: { toString: () => '12' } },
  { ...value, formId: null },
  { ...value, formId: [] }
]) {
  assert.deepEqual(summarizeReportDrafts([{ ...entry, value: invalidValue }], worker, [template]), []);
}
assert.deepEqual(summarizeReportDrafts([null, [], 'draft', entry], worker, [template]).map((draft) => draft.formId), [51]);
assert.deepEqual(summarizeReportDrafts(null, worker, [template]), []);
console.log('ok - malformed rows, unknown schemas, Daywork, recovery and tombstones stay out');

const legacyValue = { ...value };
delete legacyValue.departmentId;
delete legacyValue.templatePurpose;
delete legacyValue.definitionVersion;
delete legacyValue.fields;
const legacyEntry = { ...entry, value: legacyValue };
assert.equal(isReportDraftForWorker(legacyValue, worker, template), true);
assert.equal(isReportDraftForWorker(value, worker, template), true);
assert.equal(summarizeReportDrafts([legacyEntry], worker, [template])[0].availability, 'template_changed');
for (const inaccessibleTemplate of [null,
  { ...template, id: 99 },
  { ...template, status: 'archived' },
  { ...template, department_id: 4 },
  { ...template, department_id: undefined },
  { ...template, template_purpose: 'daywork' },
  { ...template, template_purpose: undefined }
]) {
  assert.equal(isReportDraftForWorker(legacyValue, worker, inaccessibleTemplate), false);
  assert.deepEqual(summarizeReportDrafts([legacyEntry], worker, [inaccessibleTemplate]), []);
}
assert.deepEqual(summarizeReportDrafts([legacyEntry], worker, []), []);
console.log('ok - unclassified legacy drafts require the current active scoped Report Template');

for (const unavailableTemplates of [[], null, [null], [{ ...template, status: 'archived' }]]) {
  assert.deepEqual(summarizeReportDrafts([entry], worker, unavailableTemplates), [{
    draftKey: entry.key, recovered: false,
    formId: 51, formName: 'Site inspection', workDate: '2026-09-15',
    savedAt: value.savedAt, availability: 'unavailable'
  }]);
}
assert.equal(isReportDraftForWorker(value, worker, { ...template, status: 'archived' }), false);
console.log('ok - explicitly scoped drafts remain visible but unavailable without an active Template');

for (const conflictingValue of [
  { ...value, department_id: 4 },
  { ...value, template_purpose: 'daywork' },
  { ...value, submissionPurpose: 'daywork' },
  { ...value, submission_purpose: 'daywork' },
  { ...value, departmentId: null },
  { ...value, templatePurpose: null },
  { ...value, templatePurpose: '' }
]) {
  assert.equal(isReportDraftForWorker(conflictingValue, worker, template), false);
  assert.deepEqual(summarizeReportDrafts([{ ...entry, value: conflictingValue }], worker, [template]), []);
}
for (const conflictingTemplate of [
  { ...template, departmentId: 4 },
  { ...template, templatePurpose: 'daywork' }
]) {
  assert.equal(isReportDraftForWorker(legacyValue, worker, conflictingTemplate), false);
  assert.deepEqual(summarizeReportDrafts([legacyEntry], worker, [conflictingTemplate]), []);
}
assert.equal(isReportDraftForWorker(value, { ...worker, id: '12', departmentId: '3' }, {
  ...template, id: '51', department_id: '3'
}), true);
console.log('ok - explicit purpose and Department aliases cannot contradict a draft’s scope');

const datedEntries = [
  { ...entry, key: 'work-form-draft:12:52', value: {
    ...value, formId: 52, savedAt: 'not-a-date', formName: { private: value.answers }, workDate: []
  }, updatedAt: '2026-09-14T03:25:00.000Z' },
  { ...entry, key: 'work-form-draft:12:53', value: {
    ...value, formId: 53, savedAt: null
  }, updatedAt: 'invalid-too' },
  entry
];
const datedBefore = structuredClone(datedEntries);
const summaries = summarizeReportDrafts(datedEntries, worker, [template]);
assert.deepEqual(summaries.map((draft) => draft.formId), [51, 52, 53]);
assert.equal(summaries[1].savedAt, '2026-09-14T03:25:00.000Z');
assert.equal(summaries[1].formName, 'Report Template 52');
assert.equal(summaries[1].workDate, '');
assert.equal(summaries[2].savedAt, '');
assert.deepEqual(datedEntries, datedBefore);
console.log('ok - draft metadata is scalar, newest-first, timestamp-safe and non-mutating');

const uneditedTemplate = { ...template, definition_version: 1 };
const incompleteLegacy = {
  ...legacyValue, workDate: 'unfinished date',
  answers: { old_field: { removed: [{ handwritten: 'data:image/png;base64,preserved' }] } }
};
assert.equal(isReportDraftForWorker(incompleteLegacy, worker, uneditedTemplate), true);
assert.equal(summarizeReportDrafts([{ ...entry, value: incompleteLegacy }], worker, [uneditedTemplate])[0].availability, 'editable');
assert.equal(summarizeReportDrafts([{ ...entry, value: incompleteLegacy }], worker, [template])[0].availability, 'template_changed');
for (const definitionVersion of [0, -1, 1.5, '', 'unknown', {}, []]) {
  const unusualVersion = { ...incompleteLegacy, definitionVersion };
  assert.equal(isReportDraftForWorker(unusualVersion, worker, uneditedTemplate), true);
  assert.equal(summarizeReportDrafts([{ ...entry, value: unusualVersion }], worker, [uneditedTemplate])[0].availability, 'template_changed');
}
console.log('ok - incomplete legacy evidence survives, while invalid versions never claim editability');

const submissionShapedTemplate = { ...template, template_purpose: undefined, submissionPurpose: 'report' };
assert.equal(isReportDraftForWorker(legacyValue, worker, submissionShapedTemplate), false);
assert.deepEqual(summarizeReportDrafts([legacyEntry], worker, [submissionShapedTemplate]), []);
const legacySubmissionPurpose = { ...legacyValue, departmentId: 3, submissionPurpose: 'report' };
assert.deepEqual(summarizeReportDrafts([{ ...entry, value: legacySubmissionPurpose }], worker, []), []);
console.log('ok - legacy classification requires Template purpose, not a submission-shaped substitute');

const recoveredValue = { ...value, uploadRecovery: {
  sourceRecordId: 'failed-report-1', clientSubmissionId: 'original-attempt-1',
  ownerWorkerId: 12, departmentId: 3, formId: 51,
  recoveredAt: '2026-10-01T02:30:00.000Z', omittedPhotos: []
} };
const recoveredEntry = {
  key: 'work-form-recovery:12:3:failed-report-1', value: recoveredValue,
  updatedAt: recoveredValue.savedAt
};
assert.deepEqual(summarizeReportDrafts([entry, recoveredEntry], worker, [template]).map((draft) => ({
  formId: draft.formId, draftKey: draft.draftKey, recovered: draft.recovered
})), [
  { formId: 51, draftKey: entry.key, recovered: false },
  { formId: 51, draftKey: recoveredEntry.key, recovered: true }
]);
assert.equal(isReportDraftForWorker(recoveredValue, worker, template), true);
console.log('ok - separate recovered and ordinary drafts remain independently continuable');

for (const recovery of [null, {}, [],
  { ...recoveredValue.uploadRecovery, sourceRecordId: '' },
  { ...recoveredValue.uploadRecovery, sourceRecordId: 'x'.repeat(121) },
  { ...recoveredValue.uploadRecovery, clientSubmissionId: ' ' },
  { ...recoveredValue.uploadRecovery, clientSubmissionId: 12 },
  { ...recoveredValue.uploadRecovery, ownerWorkerId: 99 },
  { ...recoveredValue.uploadRecovery, departmentId: 4 },
  { ...recoveredValue.uploadRecovery, formId: 52 },
  { ...recoveredValue.uploadRecovery, recoveredAt: 'invalid' },
  { ...recoveredValue.uploadRecovery, omittedPhotos: null },
  { ...recoveredValue.uploadRecovery, omittedPhotos: [{ index: -1, name: 'photo', reason: 'invalid' }] },
  { ...recoveredValue.uploadRecovery, omittedPhotos: [{ index: 0, name: {}, reason: 'invalid' }] }
]) {
  const invalid = { ...recoveredValue, uploadRecovery: recovery };
  assert.equal(reportDraftKeyForWorker(invalid, worker), '');
  assert.equal(isReportDraftForWorker(invalid, worker, template), false);
  assert.deepEqual(summarizeReportDrafts([{ ...recoveredEntry, value: invalid }], worker, [template]), []);
}
for (const key of [entry.key, 'work-form-recovery:99:3:failed-report-1',
  'work-form-recovery:12:4:failed-report-1', 'work-form-recovery:12:3:failed-report-2']) {
  assert.deepEqual(summarizeReportDrafts([{ ...recoveredEntry, key }], worker, [template]), []);
}
assert.equal(reportDraftKeyForWorker(recoveredValue, worker), recoveredEntry.key);
const recoveryBefore = structuredClone(recoveredEntry);
assert.equal(summarizeReportDrafts([recoveredEntry], worker, [{ ...template, definition_version: 3 }])[0].availability, 'template_changed');
assert.equal(summarizeReportDrafts([recoveredEntry], worker, [])[0].availability, 'unavailable');
assert.deepEqual(recoveredEntry, recoveryBefore);
console.log('ok - recovered attempts reject malformed ownership, metadata and slot aliases without reinterpreting version drift');

for (const definitionVersion of [undefined, null, 0, -1, '', 'unknown', {}, []]) {
  const unknownDefinition = { ...recoveredValue, definitionVersion };
  assert.equal(isReportDraftForWorker(unknownDefinition, worker, uneditedTemplate), true,
    'The recovered copy remains discoverable rather than discarding unknown-version evidence');
  assert.equal(summarizeReportDrafts([{ ...recoveredEntry, value: unknownDefinition }], worker, [uneditedTemplate])[0].availability,
    'template_changed', 'Recovery must not infer the legacy version-one default for an unknown queued Definition');
}
assert.equal(summarizeReportDrafts([{ ...recoveredEntry, value: { ...recoveredValue, definitionVersion: '1' } }], worker, [uneditedTemplate])[0].availability, 'editable');
assert.equal(summarizeReportDrafts([{ ...entry, value: incompleteLegacy }], worker, [uneditedTemplate])[0].availability, 'editable');
console.log('ok - unknown recovered Definitions stay read-only while ordinary legacy version-one drafts remain editable');
