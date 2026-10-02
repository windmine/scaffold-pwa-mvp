function id(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && value.trim() ? value : '';
}

function workerScope(worker) {
  if (worker?.role !== 'worker' || !id(worker.id) || !id(worker.departmentId)) return null;
  return { workerId: id(worker.id), departmentId: id(worker.departmentId) };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function explicitValues(value, names) {
  return names.map((name) => value[name]).filter((item) => item !== undefined);
}

function draftDepartments(value) {
  return explicitValues(value, ['departmentId', 'department_id']);
}

function draftPurposes(value) {
  return explicitValues(value, ['templatePurpose', 'template_purpose', 'submissionPurpose', 'submission_purpose']);
}

function hasTemplatePurpose(value) {
  return explicitValues(value, ['templatePurpose', 'template_purpose']).length > 0;
}

function isOrdinaryDraft(value, scope) {
  return isObject(value)
    && value.kind === 'work-form'
    && value.schemaVersion === 1
    && !value.isDraftRecovery
    && id(value.ownerWorkerId) === scope.workerId
    && Boolean(id(value.formId))
    && draftDepartments(value).every((departmentId) => id(departmentId) === scope.departmentId)
    && draftPurposes(value).every((purpose) => purpose === 'report');
}

function isCurrentReportTemplate(template, value, scope) {
  return isObject(template)
    && id(template.id) === id(value.formId)
    && template.status === 'active'
    && draftDepartments(template).length > 0
    && draftDepartments(template).every((departmentId) => id(departmentId) === scope.departmentId)
    && hasTemplatePurpose(template)
    && draftPurposes(template).every((purpose) => purpose === 'report');
}

export function isReportDraftForWorker(value, worker, template) {
  // Identity validation deliberately does not reinterpret legacy answers or fields.
  // The caller retains Definition-version conflict handling before editable restore.
  const scope = workerScope(worker);
  return Boolean(scope && reportDraftKeyForWorker(value, worker) && isCurrentReportTemplate(template, value, scope));
}

// Recovered attempts have their own slot so opening one never replaces the
// Worker's ordinary unfinished Report for the same Template.
export function reportDraftKeyForWorker(value, worker) {
  const scope = workerScope(worker);
  if (!scope || !isOrdinaryDraft(value, scope)) return '';
  if (value.uploadRecovery === undefined) return `work-form-draft:${scope.workerId}:${value.formId}`;
  const recovery = value.uploadRecovery;
  const boundedKey = (key) => typeof key === 'string' && key.trim() === key && key.length > 0 && key.length <= 120;
  if (!isObject(recovery)
    || !boundedKey(recovery.sourceRecordId) || !boundedKey(recovery.clientSubmissionId)
    || id(recovery.ownerWorkerId) !== scope.workerId
    || id(recovery.departmentId) !== scope.departmentId
    || id(recovery.formId) !== id(value.formId)
    || !draftDepartments(value).length || !hasTemplatePurpose(value)
    || !timestamp(recovery.recoveredAt)
    || !Array.isArray(recovery.omittedPhotos)
    || recovery.omittedPhotos.some((photo) => !isObject(photo)
      || !Number.isSafeInteger(photo.index) || photo.index < 0
      || typeof photo.name !== 'string' || typeof photo.reason !== 'string' || !photo.reason.trim())) return '';
  return `work-form-recovery:${scope.workerId}:${scope.departmentId}:${recovery.sourceRecordId}`;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function timestamp(value) {
  if (!text(value) || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function definitionVersion(value) {
  if (value == null) return 1;
  if (!['number', 'string'].includes(typeof value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function availability(value, template) {
  if (!template) return 'unavailable';
  const savedVersion = value.uploadRecovery && value.definitionVersion == null
    ? null : definitionVersion(value.definitionVersion);
  const currentVersion = definitionVersion(template.definition_version ?? template.definitionVersion);
  return savedVersion && savedVersion === currentVersion ? 'editable' : 'template_changed';
}

export function summarizeReportDrafts(entries, worker, templates) {
  const scope = workerScope(worker);
  if (!scope || !Array.isArray(entries)) return [];
  const currentTemplates = Array.isArray(templates) ? templates : [];
  return entries.filter((entry) => (
    isObject(entry)
    && entry.key === reportDraftKeyForWorker(entry.value, worker)
    && Boolean(entry.key)
  )).flatMap(({ key, value, updatedAt }) => {
    const template = currentTemplates.find((candidate) => isCurrentReportTemplate(candidate, value, scope));
    // Older drafts have no purpose/Department. Only a current scoped Template can
    // classify those; newer explicitly scoped drafts can remain visible offline.
    if (!template && (!draftDepartments(value).length || !hasTemplatePurpose(value))) return [];
    return [{
      draftKey: key,
      recovered: Boolean(value.uploadRecovery),
      formId: value.formId,
      formName: text(value.formName) || text(template?.name) || `Report Template ${value.formId}`,
      workDate: text(value.workDate),
      savedAt: timestamp(value.savedAt) || timestamp(updatedAt),
      availability: availability(value, template)
    }];
  }).sort((left, right) => (Date.parse(right.savedAt) || 0) - (Date.parse(left.savedAt) || 0));
}
