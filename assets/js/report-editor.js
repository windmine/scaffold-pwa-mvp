import { updateSupervisorFormSubmission, uploadPhoto } from './api-client.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { dataUrlToBlob, photoMetadataFromFile, uploadImageValidationError } from './utils.js';

// Edits belong to one authenticated session and the captured server revision.
// Conflicts leave the editor intact; a failed/uncertain save is never replayed.
export function createReportEditor({ state, showEditPanel, closeEditPanel, captureSession,
  isCurrentSession, handleSessionExpired, onSaved, notify }) {
  let active = null;
  const current = (entry) => active === entry && isCurrentSession(entry.session)
    && entry.container?.isConnected;

  function dispose() {
    const entry = active;
    active = null;
    entry?.photos.forEach((photo) => { if (photo.file) URL.revokeObjectURL(photo.preview); });
  }

  function resetSession() {
    dispose();
    closeEditPanel();
  }

  function message(entry, text, error = false) {
    if (!current(entry)) return;
    entry.feedback.textContent = text;
    entry.feedback.classList.toggle('is-error', error);
    entry.feedback.hidden = !text;
  }

  function focus() {
    active?.container?.scrollIntoView({ block: 'start' });
    active?.container?.querySelector('input, textarea, select')?.focus();
  }

  async function prepareForNavigation() {
    if (!active || !current(active)) return { safe: true };
    focus();
    return { safe: false, workspace: 'review', message: active.busy
      ? 'Wait until the Report finishes saving.'
      : 'Save your Report changes or cancel editing before leaving or updating.' };
  }

  async function uploadSignatures(entry, answers) {
    const result = structuredClone(answers);
    async function upload(field, target) {
      const value = target?.[field.id];
      if (typeof value !== 'string' || !value.startsWith('data:image/')) return;
      if (!current(entry)) throw new Error('The Report editing session changed.');
      const photo = await uploadPhoto(dataUrlToBlob(value), 'report-signature.png', entry.scope);
      if (!current(entry)) throw new Error('The Report editing session changed.');
      target[field.id] = photo.url;
    }
    for (const field of entry.form.fields.filter((item) => item.type === 'signature' && !item.repeat)) {
      await upload(field, result);
    }
    for (const parent of entry.form.fields.filter((item) => item.type === 'repeat')) {
      for (const row of result[parent.id] || []) {
        for (const field of entry.form.fields.filter((item) => item.type === 'signature' && item.repeat === parent.id)) {
          await upload(field, row);
        }
      }
    }
    return result;
  }

  async function save(entry) {
    if (!current(entry) || entry.busy) return;
    if (!navigator.onLine) return message(entry, 'Connect to the internet before saving Report changes.', true);
    const date = entry.container.querySelector('#editReportDate').value;
    if (!date) return message(entry, 'Report Date is required.', true);
    let answers;
    try {
      answers = collectWorkFormAnswers(entry.form, entry.fieldOptions);
    } catch (error) {
      message(entry, error.message, true);
      document.getElementById(error.fieldId)?.focus();
      return;
    }
    const site = entry.container.querySelector('#editReportSite').value;
    entry.busy = true;
    const controls = [...entry.container.querySelectorAll('input, textarea, select, button')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    entry.fieldOptions.container.inert = true;
    message(entry, 'Saving Report…');
    try {
      answers = await uploadSignatures(entry, answers);
      for (const photo of entry.photos) {
        if (!current(entry)) return;
        if (!photo.url) photo.url = (await uploadPhoto(photo.file, photo.file.name, entry.scope)).url;
      }
      if (!current(entry)) return;
      await updateSupervisorFormSubmission(entry.record.backendRecordId, {
        expected_revision: entry.record.revision,
        site_id: site ? Number(site) : null, work_date: date, answers,
        photo_urls: entry.photos.map((photo) => photo.url),
        photo_metadata: entry.photos.map((photo) => ({ ...photo.metadata, url: photo.url }))
      }, entry.scope);
      if (!current(entry)) return;
      entry.busy = false;
      closeEditPanel('supervisor', { reason: 'saved' });
      notify('Report updated.');
      await onSaved();
    } catch (error) {
      if (!current(entry)) return;
      if ([401, 403].includes(error.status)) {
        handleSessionExpired();
        return;
      }
      message(entry, error.status === 409 && error.code === 'report_revision_conflict'
        ? 'This Report changed since you opened it. Your edits are still here. Copy any changes you need, then cancel and reopen the latest Report.'
        : error.message || 'Could not save the Report. Your edits are still here.', true);
    } finally {
      entry.busy = false;
      if (current(entry)) {
        entry.fieldOptions.container.inert = false;
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
      }
    }
  }

  function renderPhotos(entry) {
    const list = entry.container.querySelector('[data-report-edit-photos]');
    list.replaceChildren();
    entry.photos.forEach((photo, index) => {
      const item = document.createElement('div');
      item.className = 'report-edit-photo';
      const image = document.createElement('img');
      image.src = photo.preview;
      image.alt = photo.metadata.name || `Photo ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost';
      remove.textContent = 'Remove photo';
      remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.addEventListener('click', () => {
        if (!current(entry) || entry.busy) return;
        entry.photos.splice(index, 1);
        if (photo.file) URL.revokeObjectURL(photo.preview);
        renderPhotos(entry);
      });
      item.append(image, remove);
      list.append(item);
    });
    entry.container.querySelector('[data-report-edit-photo-count]').textContent = `${entry.photos.length} / 50 photos`;
  }

  function open(record, sites) {
    if (active && current(active)) { focus(); return; }
    if (!Number.isInteger(record.revision) || record.revision < 1) {
      notify('Refresh Reports before editing. This server must support Report corrections.', true);
      return;
    }
    dispose();
    const entry = {
      record, session: captureSession(), busy: false,
      scope: { workerId: state.user.id, departmentId: state.user.departmentId, role: 'supervisor' },
      form: { id: record.formId, fields: record.fields || [] },
      photos: (record.photoUrls || []).map((url, index) => ({ url, preview: url, metadata: record.photoMetadata?.[index] || {} }))
    };
    active = entry;
    const choices = [{ value: '', label: 'No site' }, ...sites.map((site) => ({ value: site.id, label: site.name }))];
    if (record.siteId && !choices.some((site) => String(site.value) === String(record.siteId))) {
      choices.push({ value: record.siteId, label: record.siteName || 'Current site' });
    }
    const opened = showEditPanel(`Edit Report: ${record.formName || 'Report'}`, [
      { type: 'custom', html: '<p>Changes update this Report for its author and Supervisors. Previously emailed PDFs keep the original submission.</p>' },
      { id: 'editReportDate', label: 'Report Date', type: 'date', value: record.workDate },
      { id: 'editReportSite', label: 'Site', type: 'select', value: record.siteId || '', options: choices },
      { type: 'custom', html: `<div id="reportEditAnswers" class="dynamic-fields"></div>
        <section class="report-edit-evidence"><h3>Photos</h3><p data-report-edit-photo-count></p>
        <div class="report-edit-photos" data-report-edit-photos></div>
        <label>Add photos<input data-report-edit-add type="file" multiple accept="image/jpeg,image/png,image/webp"></label>
        <p class="muted">Up to 50 photos, 5 MB each.</p></section>
        <p data-report-edit-feedback role="status" aria-live="polite" hidden></p>` }
    ], 'Save Report', () => save(entry), 'supervisor', {
      warning: 'Check your corrections before saving.',
      closeGuard: (reason) => {
        if (active !== entry || (!entry.busy && ['cancel', 'saved'].includes(reason))) return true;
        message(entry, entry.busy ? 'Wait until the Report finishes saving.'
          : 'Save your Report changes or cancel editing before leaving or updating.', true);
        return false;
      },
      onClose: () => { if (active === entry) dispose(); }
    });
    if (opened === false) { dispose(); return; }
    entry.container = document.getElementById('reportEditAnswers')?.closest('form');
    entry.feedback = entry.container.querySelector('[data-report-edit-feedback]');
    entry.container.querySelector('#editReportDate').required = true;
    entry.fieldOptions = { idPrefix: 'reportCorrectionField', container: document.getElementById('reportEditAnswers'),
      preserveUploadedSignatures: true, preserveEmptyRepeats: true };
    renderWorkFormFields(entry.fieldOptions.container, entry.form, entry.fieldOptions);
    populateWorkFormAnswers(entry.form, record.answers || {}, entry.fieldOptions);
    renderPhotos(entry);
    entry.container.querySelector('[data-report-edit-add]').addEventListener('change', (event) => {
      if (!current(entry) || entry.busy) return;
      const files = [...event.target.files];
      event.target.value = '';
      const error = files.map(uploadImageValidationError).find(Boolean);
      if (error || entry.photos.length + files.length > 50) {
        message(entry, error || 'A Report can include up to 50 photos.', true);
        return;
      }
      entry.photos.push(...files.map((file) => ({ file, preview: URL.createObjectURL(file), metadata: photoMetadataFromFile(file) })));
      message(entry, '');
      renderPhotos(entry);
    });
    focus();
  }

  window.addEventListener('beforeunload', (event) => {
    if (!active || !current(active)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  return { open, resetSession, prepareForNavigation, focus, hasActive: () => Boolean(active && current(active)) };
}
