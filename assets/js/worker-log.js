import { saveDraft } from './mock-api.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { fileToDataUrl, photoMetadataFromFile, todayDateInput, uuid } from './utils.js';

const DAYWORK_FIELD_PREFIX = 'dayworkFormField';

function dayworkScore(form) {
  const text = `${form.name || ''} ${form.description || ''}`.toLowerCase();
  if (text.includes('daywork log form')) return 5;
  if (text.includes('daywork') && text.includes('log')) return 4;
  if (text.includes('daywork')) return 3;
  if (text.includes('daily') && text.includes('work')) return 2;
  return 0;
}

export function createWorkerLogModule({
  els,
  state,
  photoViewer,
  maxPhotos,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary,
  renderHistory,
  handleSessionExpired,
  isBackendSessionError
}) {
  function selectedDayworkForm() {
    return [...state.workForms]
      .filter((form) => form.status === 'active')
      .map((form) => ({ form, score: dayworkScore(form) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(a.form.name).localeCompare(String(b.form.name)))[0]?.form || null;
  }

  function setSubmitting(isSubmitting) {
    state.submittingTask = isSubmitting;
    els.submitTaskButton.disabled = isSubmitting || !selectedDayworkForm();
    els.saveTaskDraftButton.disabled = isSubmitting;
  }

  function renderDayworkForm() {
    const form = selectedDayworkForm();
    state.dayworkFormId = form?.id || null;

    if (!form) {
      els.dayworkFormHint.textContent = 'No active Daywork log form is available.';
      els.dayworkFormFields.innerHTML = '<div class="empty-state">Ask a supervisor to create or activate a form named Daywork log form.</div>';
      setSubmitting(false);
      return;
    }

    els.dayworkFormHint.textContent = form.description || form.name;
    renderWorkFormFields(els.dayworkFormFields, form, { idPrefix: DAYWORK_FIELD_PREFIX, container: els.dayworkFormFields });

    if (String(state.dayworkLogDraft?.formId || '') === String(form.id)) {
      populateWorkFormAnswers(form, state.dayworkLogDraft.answers || {}, { idPrefix: DAYWORK_FIELD_PREFIX, container: els.dayworkFormFields });
    }

    setSubmitting(false);
  }

  async function persistDraft() {
    const form = selectedDayworkForm();
    const answers = form
      ? collectWorkFormAnswers(form, { idPrefix: DAYWORK_FIELD_PREFIX, validate: false, container: els.dayworkFormFields })
      : {};

    await saveDraft('task-form', {
      kind: 'daywork-form',
      formId: form?.id || null,
      siteId: els.taskSite.value,
      workDate: els.taskDate.value,
      answers,
      photoDataUrls: state.taskPhotoDataUrls,
      photoMetadata: state.taskPhotoMetadata || []
    });
    renderStatusBanner('Daywork draft saved on this device.');
  }

  async function handlePhotoChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    const files = selectedFiles.slice(0, maxPhotos);
    state.taskPhotoFiles = files;
    state.taskPhotoDataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
    state.taskPhotoMetadata = files.map(photoMetadataFromFile);
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Daywork photo', state.taskPhotoMetadata);
    await persistDraft();
    if (selectedFiles.length > maxPhotos) {
      renderStatusBanner(`Daywork logs can include up to ${maxPhotos} photos. The first ${maxPhotos} were kept.`, true);
    }
  }

  function resetForm() {
    els.taskSite.value = '';
    els.taskDate.value = todayDateInput();
    els.taskPhoto.value = '';
    state.taskPhotoDataUrls = [];
    state.taskPhotoFiles = [];
    state.taskPhotoMetadata = [];
    state.dayworkLogDraft = null;
    photoViewer.renderPreviews(els.taskPhotoPreview, [], 'Daywork photo');
    renderDayworkForm();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingTask) return;

    const form = selectedDayworkForm();
    if (!form) {
      renderStatusBanner('No active Daywork log form is available.', true);
      return;
    }

    if (!els.taskSite.value || !els.taskDate.value) {
      renderStatusBanner('Site and work date are required.', true);
      return;
    }

    const site = findSiteByFormValue(els.taskSite.value);
    if (!site) {
      renderStatusBanner('Please select a valid site first.', true);
      return;
    }

    setSubmitting(true);
    try {
      const localRecord = {
        id: uuid(),
        type: 'form',
        formId: form.id,
        formName: form.name,
        fields: form.fields || [],
        userId: state.user.id,
        userName: state.user.fullName,
        siteId: site.id,
        siteName: site.name,
        workDate: els.taskDate.value,
        answers: await collectWorkFormAnswers(form, { idPrefix: DAYWORK_FIELD_PREFIX, container: els.dayworkFormFields }),
        photoDataUrls: state.taskPhotoDataUrls,
        photoMetadata: state.taskPhotoMetadata || [],
        photoUrls: [],
        createdAt: new Date().toISOString()
      };

      const result = await submitOfflineSubmission(localRecord, {
        draftKey: 'task-form',
        photoFiles: state.taskPhotoFiles
      });

      resetForm();
      await syncQueueIfPossible(!result.offline);
      renderStatusBanner(result.message, result.offline);
      await renderWorkerSummary();
      await renderHistory();
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not submit Daywork log.', true);
    } finally {
      setSubmitting(false);
    }
  }

  function restoreDraft(taskDraft) {
    if (!taskDraft) return;

    state.dayworkLogDraft = taskDraft;
    els.taskSite.value = taskDraft.siteId || '';
    els.taskDate.value = taskDraft.workDate || todayDateInput();
    state.taskPhotoDataUrls = taskDraft.photoDataUrls || (taskDraft.photoDataUrl ? [taskDraft.photoDataUrl] : []);
    state.taskPhotoMetadata = taskDraft.photoMetadata || [];
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Daywork draft photo', state.taskPhotoMetadata);
    renderDayworkForm();
  }

  function bindEvents() {
    els.taskPhoto.addEventListener('change', handlePhotoChange);
    els.taskForm.addEventListener('submit', handleSubmit);
    els.saveTaskDraftButton.addEventListener('click', persistDraft);
  }

  return {
    bindEvents,
    refreshTaskTemplates: renderDayworkForm,
    renderDayworkForm,
    restoreDraft
  };
}
