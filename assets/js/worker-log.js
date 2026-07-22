import { saveDraft } from './mock-api.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { getTeamWorkLogMembers } from './api-client.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { setDateInputValue } from './date-inputs.js';
import {
  fileToDataUrl,
  photoMetadataFromFile,
  todayDateInput,
  uploadImageValidationError,
  uuid
} from './utils.js';

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
  feedback,
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
  let teamMembersLoadedForUserId = null;
  let teamMemberLoadPromise = null;
  let renderedDayworkForm = null;

  function dayworkFieldOptions() {
    return {
      idPrefix: DAYWORK_FIELD_PREFIX,
      container: els.dayworkFormFields,
      enhanceDayworkTeamMembers: true,
      teamMembers: teamMembersLoadedForUserId === state.user?.id ? state.teamWorkLogMembers || [] : []
    };
  }

  function shouldLoadTeamMembers() {
    return state.user?.role === 'worker'
      && state.user?.workerClass === 'leader'
      && teamMembersLoadedForUserId !== state.user.id
      && !teamMemberLoadPromise;
  }

  function ensureTeamMembersLoaded() {
    if (!shouldLoadTeamMembers()) return;

    const requestedUserId = state.user.id;
    const request = getTeamWorkLogMembers()
      .then((members) => {
        if (String(state.user?.id || '') !== String(requestedUserId)) return;
        state.teamWorkLogMembers = members;
        teamMembersLoadedForUserId = requestedUserId;
        renderDayworkForm();
      })
      .catch((error) => {
        if (isBackendSessionError(error)) {
          handleSessionExpired();
          return;
        }
        renderStatusBanner(error.message || 'Could not load team members for Daywork.', true);
      })
      .finally(() => {
        if (teamMemberLoadPromise === request) teamMemberLoadPromise = null;
      });
    teamMemberLoadPromise = request;
  }

  function selectedDayworkForm() {
    return [...state.workForms]
      .filter((form) => form.status === 'active')
      .map((form) => ({ form, score: dayworkScore(form) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(a.form.name).localeCompare(String(b.form.name)))[0]?.form || null;
  }

  function setSubmitting(isSubmitting) {
    feedback.setButtonBusy(els.submitTaskButton, isSubmitting, 'Submitting daywork...');
    state.submittingTask = isSubmitting;
    els.submitTaskButton.disabled = isSubmitting || !selectedDayworkForm();
    els.saveTaskDraftButton.disabled = isSubmitting;
  }

  function captureVisibleDayworkDraft() {
    if (!renderedDayworkForm || !els.dayworkFormFields.children.length || state.user?.role !== 'worker') return;

    try {
      state.dayworkLogDraft = {
        kind: 'daywork-form',
        ownerWorkerId: state.user.id,
        formId: renderedDayworkForm.id,
        siteId: els.taskSite.value,
        workDate: els.taskDate.value,
        answers: collectWorkFormAnswers(renderedDayworkForm, { ...dayworkFieldOptions(), validate: false }),
        photoDataUrls: state.taskPhotoDataUrls,
        photoMetadata: state.taskPhotoMetadata || []
      };
    } catch {
      // Keep the last valid draft when a changing form cannot be collected safely.
    }
  }

  function renderDayworkForm(options = {}) {
    if (options.preserveCurrent !== false) captureVisibleDayworkDraft();
    const form = selectedDayworkForm();
    state.dayworkFormId = form?.id || null;
    renderedDayworkForm = form;

    if (!form) {
      els.dayworkFormHint.textContent = 'No active Daywork log form is available.';
      els.dayworkFormFields.innerHTML = '<div class="empty-state">Ask a supervisor to create or activate a form named Daywork log form.</div>';
      setSubmitting(false);
      return;
    }

    els.dayworkFormHint.textContent = form.description || form.name;
    ensureTeamMembersLoaded();
    renderWorkFormFields(els.dayworkFormFields, form, dayworkFieldOptions());

    if (String(state.dayworkLogDraft?.formId || '') === String(form.id)) {
      populateWorkFormAnswers(form, state.dayworkLogDraft.answers || {}, dayworkFieldOptions());
    }

    setSubmitting(false);
  }

  async function persistDraft() {
    const form = selectedDayworkForm();
    const answers = form
      ? collectWorkFormAnswers(form, { ...dayworkFieldOptions(), validate: false })
      : {};

    const draft = {
      kind: 'daywork-form',
      ownerWorkerId: state.user?.id,
      formId: form?.id || null,
      siteId: els.taskSite.value,
      workDate: els.taskDate.value,
      answers,
      photoDataUrls: state.taskPhotoDataUrls,
      photoMetadata: state.taskPhotoMetadata || []
    };
    state.dayworkLogDraft = draft;
    await saveDraft('task-form', draft);
    renderStatusBanner('Daywork draft saved on this device.', false, {
      local: els.taskFeedback,
      tone: 'success'
    });
  }

  async function handlePhotoChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    const files = selectedFiles.slice(0, maxPhotos);
    const validationError = files.map(uploadImageValidationError).find(Boolean);
    if (validationError) {
      event.target.value = '';
      state.taskPhotoFiles = [];
      state.taskPhotoDataUrls = [];
      state.taskPhotoMetadata = [];
      photoViewer.renderPreviews(els.taskPhotoPreview, [], 'Daywork photo');
      await persistDraft();
      renderStatusBanner(validationError, true, {
        local: els.taskFeedback,
        field: els.taskPhoto,
        tone: 'error'
      });
      return;
    }
    state.taskPhotoFiles = files;
    state.taskPhotoDataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
    state.taskPhotoMetadata = files.map(photoMetadataFromFile);
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Daywork photo', state.taskPhotoMetadata);
    await persistDraft();
    if (selectedFiles.length > maxPhotos) {
      renderStatusBanner(`Daywork logs can include up to ${maxPhotos} photos. The first ${maxPhotos} were kept.`, true, {
        local: els.taskFeedback,
        tone: 'warning'
      });
    }
  }

  function resetForm(options = {}) {
    els.taskSite.value = '';
    setDateInputValue(els.taskDate, todayDateInput());
    els.taskPhoto.value = '';
    state.taskPhotoDataUrls = [];
    state.taskPhotoFiles = [];
    state.taskPhotoMetadata = [];
    state.dayworkLogDraft = null;
    photoViewer.renderPreviews(els.taskPhotoPreview, [], 'Daywork photo');
    if (options.render !== false) {
      renderDayworkForm({ preserveCurrent: false });
    } else {
      els.dayworkFormFields.innerHTML = '';
      els.dayworkFormHint.textContent = 'Loading Daywork log form...';
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingTask) return;

    const form = selectedDayworkForm();
    if (!form) {
      renderStatusBanner('No active Daywork log form is available.', true, {
        local: els.taskFeedback,
        tone: 'error'
      });
      return;
    }

    if (!els.taskSite.value || !els.taskDate.value) {
      const field = !els.taskSite.value ? els.taskSite : els.taskDate;
      renderStatusBanner('Site and work date are required.', true, {
        local: els.taskFeedback,
        field,
        tone: 'error'
      });
      return;
    }

    const site = findSiteByFormValue(els.taskSite.value);
    if (!site) {
      renderStatusBanner('Please select a valid site first.', true, {
        local: els.taskFeedback,
        field: els.taskSite,
        tone: 'error'
      });
      return;
    }

    feedback.clearLocal(els.taskFeedback);
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
        answers: await collectWorkFormAnswers(form, dayworkFieldOptions()),
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
      renderStatusBanner(result.message, result.offline, {
        local: els.taskFeedback,
        tone: result.offline ? 'warning' : 'success'
      });
      await renderWorkerSummary();
      await renderHistory();
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      const invalidField = error.fieldId ? document.getElementById(error.fieldId) : null;
      renderStatusBanner(error.message || 'Could not submit Daywork log.', true, {
        local: els.taskFeedback,
        field: invalidField,
        tone: 'error'
      });
    } finally {
      setSubmitting(false);
    }
  }

  function restoreDraft(taskDraft) {
    if (!taskDraft || String(taskDraft.ownerWorkerId || '') !== String(state.user?.id || '')) return;

    state.dayworkLogDraft = taskDraft;
    els.taskSite.value = taskDraft.siteId || '';
    setDateInputValue(els.taskDate, taskDraft.workDate || todayDateInput());
    state.taskPhotoDataUrls = taskDraft.photoDataUrls || (taskDraft.photoDataUrl ? [taskDraft.photoDataUrl] : []);
    state.taskPhotoMetadata = taskDraft.photoMetadata || [];
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Daywork draft photo', state.taskPhotoMetadata);
    renderDayworkForm();
  }

  function clearSessionState() {
    feedback.clearLocal(els.taskFeedback);
    teamMembersLoadedForUserId = null;
    teamMemberLoadPromise = null;
    renderedDayworkForm = null;
    resetForm({ render: false });
  }

  function bindEvents() {
    els.taskPhoto.addEventListener('change', handlePhotoChange);
    els.taskForm.addEventListener('submit', handleSubmit);
    els.saveTaskDraftButton.addEventListener('click', persistDraft);
  }

  return {
    bindEvents,
    clearSessionState,
    refreshTaskTemplates: renderDayworkForm,
    renderDayworkForm,
    restoreDraft
  };
}
