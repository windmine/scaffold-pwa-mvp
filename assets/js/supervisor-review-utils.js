import { uploadPhoto as uploadBackendPhoto } from './api-client.js';
import { dataUrlToBlob } from './utils.js';

const TEAM_BREAK_MINUTE_OPTIONS = [0, 15, 30, 45, 60];

export function mergeReviewRecords(...recordGroups) {
  const recordsByKey = new Map();

  recordGroups.flat().filter(Boolean).forEach((record) => {
    const key = `${record.type || 'record'}:${record.backendRecordId || record.id}`;
    recordsByKey.set(key, record);
  });

  return Array.from(recordsByKey.values())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export function reviewRecordCounts(records) {
  return records.reduce((counts, record) => {
    if (record.status === 'pending') counts.pending += 1;
    if (record.status === 'approved' || record.status === 'rejected') counts.reviewed += 1;
    if (record.type === 'attendance') counts.attendance += 1;
    if (record.type === 'task') counts.task += 1;
    if (record.type === 'team_log') counts.teamLog += 1;
    if (record.type === 'form') counts.form += 1;
    return counts;
  }, {
    pending: 0,
    reviewed: 0,
    attendance: 0,
    task: 0,
    teamLog: 0,
    form: 0
  });
}

export function formatAuditAction(action) {
  return (action || 'change').replaceAll('_', ' ');
}

export function isDayworkRecord(record) {
  const text = `${record.formName || ''}`.toLowerCase();
  return text.includes('daywork') || text.includes('daily work');
}

export function isDayworkForm(form) {
  const text = `${form?.name || ''}`.toLowerCase();
  return text.includes('daywork') || text.includes('daily work');
}

export function exportUsesFormType(exportType) {
  return [
    'daywork-pdf',
    'form-submissions',
    'form-submissions-csv',
    'form-submissions-pdf'
  ].includes(exportType);
}

function isSignatureDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

export async function uploadAdminFormSignatureAnswers(form, answers, user) {
  const fields = form.fields || [];
  const nextAnswers = { ...answers };

  async function uploadSignature(field, target, suffix = '') {
    const value = target?.[field.id];
    if (!isSignatureDataUrl(value)) return;

    const uploaded = await uploadBackendPhoto(
      dataUrlToBlob(value),
      `admin-signature-${user?.id || 'user'}-${form.id}-${field.id}${suffix}-${Date.now()}.png`
    );
    target[field.id] = uploaded.url;
  }

  for (const field of fields.filter((item) => item.type === 'signature' && !item.repeat)) {
    await uploadSignature(field, nextAnswers);
  }

  for (const parent of fields.filter((item) => item.type === 'repeat')) {
    const rows = Array.isArray(nextAnswers[parent.id]) ? nextAnswers[parent.id] : [];
    const children = fields.filter((item) => item.repeat === parent.id && item.type === 'signature');
    for (const [index, row] of rows.entries()) {
      for (const child of children) {
        await uploadSignature(child, row, `-${parent.id}-${index + 1}`);
      }
    }
  }

  return nextAnswers;
}

function signatureFieldsForForm(form) {
  return (form?.fields || []).filter((field) => field.type === 'signature');
}

function repeatSignatureFieldsForForm(form, repeatId) {
  return signatureFieldsForForm(form).filter((field) => field.repeat === repeatId);
}

export function mergeExistingSignatureAnswers(form, nextAnswers, existingAnswers = {}) {
  const merged = { ...nextAnswers };

  signatureFieldsForForm(form)
    .filter((field) => !field.repeat)
    .forEach((field) => {
      if (!merged[field.id] && existingAnswers[field.id]) {
        merged[field.id] = existingAnswers[field.id];
      }
    });

  (form?.fields || [])
    .filter((field) => field.type === 'repeat')
    .forEach((parent) => {
      const rows = Array.isArray(merged[parent.id]) ? merged[parent.id] : [];
      const existingRows = Array.isArray(existingAnswers[parent.id]) ? existingAnswers[parent.id] : [];
      const signatureChildren = repeatSignatureFieldsForForm(form, parent.id);
      rows.forEach((row, index) => {
        const existingRow = existingRows[index] || {};
        signatureChildren.forEach((field) => {
          if (!row[field.id] && existingRow[field.id]) {
            row[field.id] = existingRow[field.id];
          }
        });
      });
    });

  return merged;
}

function normaliseTeamBreakMinutes(value, fallback = 0) {
  const minutes = Number(value);
  return TEAM_BREAK_MINUTE_OPTIONS.includes(minutes) ? minutes : fallback;
}

function teamBreakLabel(minutes) {
  if (minutes === 0) return 'No break';
  if (minutes === 60) return '1 hour';
  return `${minutes} minutes`;
}

export function teamBreakOptions(selected = 0) {
  const selectedValue = normaliseTeamBreakMinutes(selected);
  return TEAM_BREAK_MINUTE_OPTIONS
    .map((minutes) => (
      `<option value="${minutes}"${minutes === selectedValue ? ' selected' : ''}>${teamBreakLabel(minutes)}</option>`
    ))
    .join('');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localDateTimeInputValue(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const localTime = new Date(date.getTime() - (date.getTimezoneOffset() * 60 * 1000));
  return localTime.toISOString().slice(0, 16);
}
