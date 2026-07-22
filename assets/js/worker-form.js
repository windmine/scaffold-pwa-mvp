import { getWorkForms as getBackendWorkForms } from './api-client.js';
import { getDraft, saveDraft } from './mock-api.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { setDateInputValue } from './date-inputs.js';
import {
  fileToDataUrl,
  todayDateInput,
  uploadImageValidationError,
  uuid,
  escapeHtml,
  photoMetadataFromFile
} from './utils.js';

const WORK_FORM_DRAFT_PREFIX = 'work-form-draft';
const WORK_FORM_DRAFT_SCHEMA_VERSION = 1;
const AUTOSAVE_DELAY_MS = 650;

function workFormDraftKey(workerId, formId) {
  return `${WORK_FORM_DRAFT_PREFIX}:${workerId}:${formId}`;
}

function definitionVersion(form) {
  return Number(form?.definition_version || form?.definitionVersion || 1);
}

function savedTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

export function createWorkerFormModule({
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
  isBackendSessionError,
  onSupervisorWorkFormsChanged = () => {},
  onWorkFormsChanged = () => {}
}) {
  let renderedWorkForm = null;
  let autosaveTimer = null;
  let selectionToken = 0;
  let restoringDraft = false;
  let reloadLocked = false;
  let submissionControlStates = [];
  let photoSelectionToken = 0;
  let photoProcessing = {
    key: '',
    pending: false,
    error: null,
    promise: Promise.resolve()
  };
  const draftStates = new Map();

  function setAutosaveStatus(message, stateClass = '', savedAt = '') {
    if (!els.workFormAutosaveStatus) return;
    const currentStateClass = els.workFormAutosaveStatus.classList.contains('error')
      ? 'error'
      : els.workFormAutosaveStatus.classList.contains('saved')
        ? 'saved'
        : '';
    if (
      els.workFormAutosaveStatus.textContent === message
      && currentStateClass === stateClass
      && (els.workFormAutosaveStatus.dataset.savedAt || '') === savedAt
    ) return;
    els.workFormAutosaveStatus.textContent = message;
    els.workFormAutosaveStatus.classList.remove('saved', 'error');
    if (stateClass) els.workFormAutosaveStatus.classList.add(stateClass);
    if (savedAt) {
      els.workFormAutosaveStatus.dataset.savedAt = savedAt;
    } else {
      delete els.workFormAutosaveStatus.dataset.savedAt;
    }
  }

  function showDefaultAutosaveStatus() {
    setAutosaveStatus('Changes save automatically on this device.');
  }

  function showSavedStatus(savedAt, restored = false) {
    const time = savedTimeLabel(savedAt);
    const message = time
      ? `Saved at ${time}.${restored ? ' Draft restored on this device.' : ''}`
      : 'Draft saved on this device.';
    setAutosaveStatus(message, 'saved', savedAt || '');
  }

  function showDraftSaveError() {
    setAutosaveStatus('Changes not saved. Keep this page open and try again.', 'error');
  }

  function renderWorkFormOptions() {
    const selectedValue = els.workFormSelect.value;
    const options = ['<option value="">Select a form</option>']
      .concat(
        state.workForms
          .filter((form) => form.status === 'active')
          .map((form) => `<option value="${form.id}">${escapeHtml(form.name)}</option>`)
      )
      .join('');

    els.workFormSelect.innerHTML = options;
    els.workFormSelect.value = state.workForms.some((form) => String(form.id) === selectedValue && form.status === 'active')
      ? selectedValue
      : '';
  }

  function selectedWorkForm(formId = els.workFormSelect.value) {
    return state.workForms.find((form) => String(form.id) === String(formId));
  }

  function draftStateFor(form, workerId = state.user?.id) {
    if (!form || workerId == null) return null;
    const key = workFormDraftKey(workerId, form.id);
    if (!draftStates.has(key)) {
      draftStates.set(key, {
        key,
        ownerWorkerId: workerId,
        formId: form.id,
        revision: 0,
        savedRevision: 0,
        savedAt: '',
        snapshot: null,
        error: null,
        flushPromise: null
      });
    }
    return draftStates.get(key);
  }

  function activeDraftState() {
    if (!renderedWorkForm || state.user?.role !== 'worker') return null;
    return draftStateFor(renderedWorkForm);
  }

  function buildDraftSnapshot(form, draftState, savedAt = draftState?.savedAt || '') {
    if (!form || !draftState || String(state.user?.id || '') !== String(draftState.ownerWorkerId)) return null;
    return {
      kind: 'work-form',
      schemaVersion: WORK_FORM_DRAFT_SCHEMA_VERSION,
      ownerWorkerId: draftState.ownerWorkerId,
      formId: form.id,
      formName: form.name,
      definitionVersion: definitionVersion(form),
      siteId: els.workFormSite.value || '',
      workDate: els.workFormDate.value || '',
      answers: collectWorkFormAnswers(form, {
        container: els.workFormFields,
        validate: false
      }),
      photoDataUrls: [...state.workFormPhotoDataUrls],
      photoMetadata: state.workFormPhotoMetadata.map((item) => ({ ...item })),
      savedAt
    };
  }

  function captureVisibleWorkFormDraft() {
    const draftState = activeDraftState();
    if (!draftState || !els.workFormFields.children.length) return null;
    draftState.snapshot = buildDraftSnapshot(renderedWorkForm, draftState);
    return draftState.snapshot;
  }

  function sameDraftContent(left, right) {
    if (!left || !right) return false;
    return String(left.siteId || '') === String(right.siteId || '')
      && String(left.workDate || '') === String(right.workDate || '')
      && JSON.stringify(left.answers || {}) === JSON.stringify(right.answers || {})
      && JSON.stringify(left.photoMetadata || []) === JSON.stringify(right.photoMetadata || [])
      && (left.photoDataUrls || []).length === (right.photoDataUrls || []).length
      && (left.photoDataUrls || []).every((value, index) => value === right.photoDataUrls[index]);
  }

  function cancelAutosaveTimer() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  function scheduleDraftSave() {
    cancelAutosaveTimer();
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      void flushActiveDraft().catch(() => {});
    }, AUTOSAVE_DELAY_MS);
  }

  function markActiveDraftDirty(options = {}) {
    if (restoringDraft || reloadLocked || state.submittingWorkForm) return;
    const draftState = activeDraftState();
    if (!draftState) return;

    draftState.error = null;
    if (options.capture !== false) {
      try {
        const nextSnapshot = buildDraftSnapshot(renderedWorkForm, draftState);
        if (sameDraftContent(nextSnapshot, draftState.snapshot)) return;
        draftState.snapshot = nextSnapshot;
      } catch (error) {
        draftState.error = error;
      }
    }
    draftState.revision += 1;
    setAutosaveStatus('Saving draft...');
    scheduleDraftSave();
  }

  async function waitForDraftPhotos(draftState) {
    if (photoProcessing.key !== draftState?.key) return;
    if (photoProcessing.pending) await photoProcessing.promise;
    if (photoProcessing.error) throw photoProcessing.error;
  }

  async function persistDraftState(draftState) {
    if (!draftState || draftState.savedRevision >= draftState.revision) return;
    if (draftState.flushPromise) {
      await draftState.flushPromise;
      if (draftState.savedRevision < draftState.revision) await persistDraftState(draftState);
      return;
    }

    draftState.flushPromise = (async () => {
      while (draftState.savedRevision < draftState.revision) {
        await waitForDraftPhotos(draftState);
        if (activeDraftState()?.key === draftState.key) captureVisibleWorkFormDraft();
        if (!draftState.snapshot) throw new Error('Could not capture this Work Form draft.');

        const revisionToSave = draftState.revision;
        const savedAt = new Date().toISOString();
        const snapshot = {
          ...draftState.snapshot,
          savedAt
        };
        await saveDraft(draftState.key, snapshot);
        draftState.snapshot = snapshot;
        draftState.savedAt = savedAt;
        draftState.savedRevision = revisionToSave;
        draftState.error = null;
      }
    })();

    try {
      await draftState.flushPromise;
      if (activeDraftState()?.key === draftState.key) showSavedStatus(draftState.savedAt);
    } catch (error) {
      draftState.error = error;
      if (activeDraftState()?.key === draftState.key) showDraftSaveError();
      throw error;
    } finally {
      draftState.flushPromise = null;
    }
  }

  async function flushActiveDraft() {
    cancelAutosaveTimer();
    const draftState = activeDraftState();
    if (!draftState) return;
    await persistDraftState(draftState);
  }

  async function flushAllDrafts() {
    cancelAutosaveTimer();
    const activeState = activeDraftState();
    if (activeState && activeState.revision > activeState.savedRevision) {
      await waitForDraftPhotos(activeState);
      captureVisibleWorkFormDraft();
    }
    for (const draftState of draftStates.values()) {
      if (draftState.revision > draftState.savedRevision) await persistDraftState(draftState);
    }
  }

  async function flushPendingDrafts() {
    if (state.submittingWorkForm) {
      throw new Error('Wait for the Work Form submission to finish.');
    }
    await flushAllDrafts();
    if (hasUnsavedInput()) throw new Error('This Work Form still has unsaved changes.');
  }

  function hasUnsavedInput() {
    if (state.submittingWorkForm) return true;
    if (photoProcessing.pending) return true;
    return [...draftStates.values()].some((draftState) => draftState.revision > draftState.savedRevision);
  }

  async function prepareForAppUpdate() {
    if (state.submittingWorkForm) {
      return {
        safe: false,
        message: 'Wait for the Work Form submission to finish before updating.'
      };
    }

    try {
      await flushPendingDrafts();
    } catch {
      return {
        safe: false,
        message: 'This Work Form has changes that are not saved on this device. Updating now could lose them.'
      };
    }

    if (hasUnsavedInput()) {
      showDraftSaveError();
      return {
        safe: false,
        message: 'This Work Form has changes that are not saved on this device. Updating now could lose them.'
      };
    }

    reloadLocked = true;
    els.workFormSubmissionForm.inert = true;
    return { safe: true };
  }

  function cancelAppUpdatePreparation() {
    reloadLocked = false;
    els.workFormSubmissionForm.inert = false;
  }

  function resetDraftSurface() {
    els.workFormSite.value = '';
    setDateInputValue(els.workFormDate, todayDateInput());
    els.workFormPhotos.value = '';
    state.workFormPhotoFiles = [];
    state.workFormPhotoDataUrls = [];
    state.workFormPhotoMetadata = [];
    photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
  }

  function validStoredDraft(value, form, draftState) {
    return value?.kind === 'work-form'
      && String(value.ownerWorkerId || '') === String(draftState.ownerWorkerId)
      && String(value.formId || '') === String(form.id);
  }

  function applyDraftToSurface(form, draftState, draft) {
    restoringDraft = true;
    try {
      if (draft.siteId && [...els.workFormSite.options].some((option) => String(option.value) === String(draft.siteId))) {
        els.workFormSite.value = String(draft.siteId);
      }
      setDateInputValue(els.workFormDate, draft.workDate || todayDateInput());
      populateWorkFormAnswers(form, draft.answers || {}, { container: els.workFormFields });
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = Array.isArray(draft.photoDataUrls) ? [...draft.photoDataUrls] : [];
      state.workFormPhotoMetadata = Array.isArray(draft.photoMetadata)
        ? draft.photoMetadata.map((item) => ({ ...item }))
        : [];
      photoViewer.renderPreviews(
        els.workFormPhotoPreview,
        state.workFormPhotoDataUrls,
        'Form photo',
        state.workFormPhotoMetadata
      );
      draftState.snapshot = {
        ...draft,
        photoDataUrls: [...state.workFormPhotoDataUrls],
        photoMetadata: state.workFormPhotoMetadata.map((item) => ({ ...item }))
      };
      draftState.savedAt = draft.savedAt || draftState.savedAt;
    } finally {
      restoringDraft = false;
    }
  }

  async function restoreSelectedDraft(form, draftState, token) {
    const restoreStartedRevision = draftState.revision;
    let draft = draftState.snapshot;
    if (!draft) {
      els.workFormSubmissionForm.inert = true;
      try {
        const storedDraft = await getDraft(draftState.key);
        draftState.error = null;
        if (validStoredDraft(storedDraft, form, draftState)) draft = storedDraft;
      } catch (error) {
        draftState.error = error;
        if (token === selectionToken) showDraftSaveError();
        return;
      } finally {
        if (token === selectionToken && !reloadLocked) els.workFormSubmissionForm.inert = false;
      }
    }

    if (
      token !== selectionToken
      || String(els.workFormSelect.value) !== String(form.id)
      || String(state.user?.id || '') !== String(draftState.ownerWorkerId)
    ) return;

    if (draftState.revision !== restoreStartedRevision) {
      setAutosaveStatus('Saving draft...');
      scheduleDraftSave();
      return;
    }

    if (!draft) {
      showDefaultAutosaveStatus();
      return;
    }

    applyDraftToSurface(form, draftState, draft);
    if (draftState.error) {
      showDraftSaveError();
    } else if (draftState.revision > draftState.savedRevision) {
      setAutosaveStatus('Saving draft...');
      scheduleDraftSave();
    } else {
      showSavedStatus(draftState.savedAt, true);
    }

    if (Number(draft.definitionVersion || 1) !== definitionVersion(form)) {
      renderStatusBanner('This draft was saved with an earlier form version. Review it before submitting.', true, {
        local: els.workFormFeedback,
        tone: 'warning'
      });
    }
  }

  async function renderSelectedWorkForm(options = {}) {
    const requestedFormId = els.workFormSelect.value;
    const token = ++selectionToken;
    if (options.preserveCurrent !== false) feedback.clearLocal(els.workFormFeedback);

    if (renderedWorkForm && options.skipFlush !== true) {
      try {
        await flushActiveDraft();
      } catch {
        if (token === selectionToken) {
          els.workFormSelect.value = String(renderedWorkForm.id);
          showDraftSaveError();
        }
        return;
      }
    }
    if (token !== selectionToken) return;

    const form = selectedWorkForm(requestedFormId);
    resetDraftSurface();
    renderWorkFormFields(els.workFormFields, form, { container: els.workFormFields });
    renderedWorkForm = form || null;
    showDefaultAutosaveStatus();
    if (!form || state.user?.role !== 'worker') return;

    const draftState = draftStateFor(form);
    await restoreSelectedDraft(form, draftState, token);
  }

  async function refreshWorkForms() {
    if (!state.user) return;
    const requestUserId = state.user.id;

    try {
      const workForms = await getBackendWorkForms();
      if (String(state.user?.id || '') !== String(requestUserId)) return;
      state.workForms = workForms;
      renderWorkFormOptions();
      await renderSelectedWorkForm({ preserveCurrent: false });
      onWorkFormsChanged();
      if (state.user.role === 'supervisor') onSupervisorWorkFormsChanged();
    } catch (error) {
      if (String(state.user?.id || '') !== String(requestUserId)) return;
      state.workForms = [];
      renderWorkFormOptions();
      if (state.user.role === 'worker') {
        renderStatusBanner(error.message || 'Could not load work forms.', true);
      }
    }
  }

  async function processPhotoChange(event, token, draftState) {
    const selectedFiles = Array.from(event.target.files || []);
    const files = selectedFiles.slice(0, maxPhotos);
    const validationError = files.map(uploadImageValidationError).find(Boolean);
    if (validationError) {
      event.target.value = '';
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
      renderStatusBanner(validationError, true, {
        local: els.workFormFeedback,
        field: els.workFormPhotos,
        tone: 'error'
      });
      return;
    }

    try {
      const dataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
      if (token !== photoSelectionToken || activeDraftState()?.key !== draftState?.key) return;
      state.workFormPhotoFiles = files;
      state.workFormPhotoDataUrls = dataUrls;
      state.workFormPhotoMetadata = files.map(photoMetadataFromFile);
      photoViewer.renderPreviews(
        els.workFormPhotoPreview,
        state.workFormPhotoDataUrls,
        'Form photo',
        state.workFormPhotoMetadata
      );

      if (selectedFiles.length > maxPhotos) {
        renderStatusBanner(`Form submissions can include up to ${maxPhotos} photos. The first ${maxPhotos} were kept.`, true, {
          local: els.workFormFeedback,
          tone: 'warning'
        });
      }
    } catch (error) {
      event.target.value = '';
      renderStatusBanner('Could not prepare these photos. Choose them again before leaving this page.', true, {
        local: els.workFormFeedback,
        field: els.workFormPhotos,
        tone: 'error'
      });
      throw error;
    }
  }

  function handlePhotoChange(event) {
    const draftState = activeDraftState();
    markActiveDraftDirty({ capture: false });
    const token = ++photoSelectionToken;
    const promise = processPhotoChange(event, token, draftState);
    photoProcessing = {
      key: draftState?.key || '',
      pending: true,
      error: null,
      promise
    };
    void promise
      .catch((error) => {
        if (photoProcessing.promise === promise) photoProcessing.error = error;
        if (activeDraftState()?.key === draftState?.key) showDraftSaveError();
      })
      .finally(() => {
        if (photoProcessing.promise === promise) photoProcessing.pending = false;
      });
  }

  function setSubmitting(isSubmitting) {
    if (isSubmitting) {
      submissionControlStates = [...els.workFormSubmissionForm.elements]
        .filter((control) => control !== els.submitWorkFormButton)
        .map((control) => ({ control, disabled: control.disabled }));
      submissionControlStates.forEach(({ control }) => {
        control.disabled = true;
      });
      els.workFormFields.inert = true;
      els.workFormSubmissionForm.setAttribute('aria-busy', 'true');
    } else {
      submissionControlStates.forEach(({ control, disabled }) => {
        if (control.isConnected) control.disabled = disabled;
      });
      submissionControlStates = [];
      els.workFormFields.inert = false;
      els.workFormSubmissionForm.removeAttribute('aria-busy');
    }
    feedback.setButtonBusy(els.submitWorkFormButton, isSubmitting, 'Submitting form...');
    state.submittingWorkForm = isSubmitting;
    els.submitWorkFormButton.disabled = isSubmitting;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingWorkForm) return;

    const form = selectedWorkForm();
    if (!form) {
      renderStatusBanner('Choose a form first.', true, {
        local: els.workFormFeedback,
        field: els.workFormSelect,
        tone: 'error'
      });
      return;
    }

    const site = els.workFormSite.value ? findSiteByFormValue(els.workFormSite.value) : null;
    if (els.workFormSite.value && !site) {
      renderStatusBanner('Please select a valid site first.', true, {
        local: els.workFormFeedback,
        field: els.workFormSite,
        tone: 'error'
      });
      return;
    }

    feedback.clearLocal(els.workFormFeedback);
    setSubmitting(true);
    const submittedDraft = draftStateFor(form);
    try {
      await waitForDraftPhotos(submittedDraft);
      try {
        await flushActiveDraft();
      } catch {
        // A successful submission is also a durable way to protect the current work.
      }

      const localRecord = {
        id: uuid(),
        type: 'form',
        formId: form.id,
        formName: form.name,
        fields: form.fields || [],
        userId: state.user.id,
        userName: state.user.fullName,
        siteId: site?.id || null,
        siteName: site?.name || 'Unassigned site',
        workDate: els.workFormDate.value || null,
        answers: await collectWorkFormAnswers(form, { container: els.workFormFields }),
        photoDataUrls: state.workFormPhotoDataUrls,
        photoMetadata: state.workFormPhotoMetadata,
        photoUrls: [],
        createdAt: new Date().toISOString()
      };

      const result = await submitOfflineSubmission(localRecord, {
        draftKey: submittedDraft.key,
        photoFiles: state.workFormPhotoFiles
      });

      cancelAutosaveTimer();
      draftStates.delete(submittedDraft.key);
      els.workFormSubmissionForm.reset();
      setDateInputValue(els.workFormDate, todayDateInput());
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
      await renderSelectedWorkForm({ preserveCurrent: false, skipFlush: true });
      await syncQueueIfPossible(!result.offline);
      const resultMessage = result.draftCleanupFailed
        ? `${result.message} The submitted draft could not be cleared from this device; do not submit it again after reloading.`
        : result.message;
      renderStatusBanner(resultMessage, result.offline || result.draftCleanupFailed, {
        local: els.workFormFeedback,
        tone: result.offline || result.draftCleanupFailed ? 'warning' : 'success'
      });
      await renderWorkerSummary();
      await renderHistory();
    } catch (error) {
      setSubmitting(false);
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      const invalidField = error.fieldId ? document.getElementById(error.fieldId) : null;
      renderStatusBanner(error.message || 'Could not submit form.', true, {
        local: els.workFormFeedback,
        field: invalidField,
        tone: 'error'
      });
    } finally {
      if (state.submittingWorkForm) setSubmitting(false);
    }
  }

  function handleDraftMutation(event) {
    if (event.target === els.workFormSelect || event.target === els.workFormPhotos) return;
    markActiveDraftDirty();
  }

  function bindEvents() {
    els.workFormSubmissionForm.addEventListener('submit', handleSubmit);
    els.workFormSelect.addEventListener('change', () => {
      void renderSelectedWorkForm();
    });
    els.workFormPhotos.addEventListener('change', handlePhotoChange);
    els.workFormSubmissionForm.addEventListener('input', handleDraftMutation);
    els.workFormSubmissionForm.addEventListener('change', handleDraftMutation);
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedInput()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function focusUnsavedInput() {
    els.workFormAutosaveStatus.setAttribute('tabindex', '-1');
    els.workFormAutosaveStatus.focus({ preventScroll: true });
    els.workFormAutosaveStatus.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearSessionState() {
    if (state.submittingWorkForm || submissionControlStates.length) setSubmitting(false);
    feedback.clearLocal(els.workFormFeedback);
    cancelAutosaveTimer();
    selectionToken += 1;
    photoSelectionToken += 1;
    renderedWorkForm = null;
    restoringDraft = false;
    reloadLocked = false;
    els.workFormSubmissionForm.inert = false;
    els.workFormSubmissionForm.removeAttribute('aria-busy');
    els.workFormFields.inert = false;
    submissionControlStates = [];
    els.workFormSubmissionForm.reset();
    els.workFormSelect.innerHTML = '<option value="">Select a form</option>';
    setDateInputValue(els.workFormDate, todayDateInput());
    els.workFormFields.innerHTML = '';
    state.workFormPhotoFiles = [];
    state.workFormPhotoDataUrls = [];
    state.workFormPhotoMetadata = [];
    photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
    photoProcessing = { key: '', pending: false, error: null, promise: Promise.resolve() };
    draftStates.clear();
    showDefaultAutosaveStatus();
  }

  return {
    bindEvents,
    cancelAppUpdatePreparation,
    clearSessionState,
    focusUnsavedInput,
    flushPendingDrafts,
    hasUnsavedInput,
    prepareForAppUpdate,
    refreshWorkForms,
    renderSelectedWorkForm
  };
}
