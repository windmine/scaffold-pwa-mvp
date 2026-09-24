import { getWorkForms as getBackendWorkForms } from './api-client.js';
import { getDraft, getDraftEntries, saveDraft } from './mock-api.js';
import { isReportDraftForWorker, summarizeReportDrafts } from './report-drafts.js';
import { createPhotoPreviewSources, reportPhotoSources, restoreReportPhotoEvidence } from './report-photo-evidence.js';
import {
  saveWorkerReportTemplateSnapshot,
  loadWorkerReportTemplateSnapshot,
  clearWorkerReportTemplateSnapshot
} from './offline-report-template-snapshot.js';
import { preserveConflictingReportDraft, submitOfflineSubmission } from './offline-submissions.js';
import { collectWorkFormAnswers, formatWorkFormAnswer, localAnswerImageSources, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { setDateInputValue } from './date-inputs.js';
import { setTranslatableText } from './i18n.js';
import {
  fileToDataUrl,
  todayDateInput,
  uploadImageValidationError,
  uuid,
  escapeHtml,
  photoMetadataFromFile,
  formatDateTime
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

function formPurpose(form) {
  const explicitPurpose = String(form?.template_purpose || form?.templatePurpose || '').trim().toLowerCase();
  if (['report', 'daywork'].includes(explicitPurpose)) return explicitPurpose;
  if (/\b(?:daywork|daily work)\b/i.test(`${form?.name || ''} ${form?.description || ''}`)) return 'daywork';
  return 'report';
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
  legacyMaxPhotos = 8,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary,
  renderHistory,
  handleSessionExpired,
  isBackendSessionError,
  reportOnly = false,
  onContinueDraft = () => {},
  onReportTemplateSourceChanged = () => {},
  onSupervisorWorkFormsChanged = () => {},
  onWorkFormsChanged = () => {}
}) {
  let renderedWorkForm = null;
  let autosaveTimer = null;
  let selectionToken = 0;
  let sessionGeneration = 0;
  let templateRequest = 0;
  let reportTemplateSource = 'unavailable';
  let reportTemplatesSavedAt = '';
  let restoringDraft = false;
  let conflictingDraft = null;
  let reloadLocked = false;
  let submissionControlStates = [];
  let photoSelectionToken = 0;
  let photoPreviewSources = createPhotoPreviewSources([]);
  state.workFormPhotoBlobs ||= [];
  let draftListRequest = 0;
  let draftContinueInFlight = false;
  let photoProcessing = {
    key: '',
    pending: false,
    error: null,
    promise: Promise.resolve()
  };
  const draftStates = new Map();
  // Storage can fail even after a Report is safe. Do not offer that submitted
  // draft again in this session; a newly saved draft may reuse its Template key.
  const submittedDraftsPendingCleanup = new Set();
  const emptyTemplateOption = 'Select a Report Template';

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
    const options = [`<option value="">${emptyTemplateOption}</option>`]
      .concat(
        state.workForms
          .filter((form) => form.status === 'active' && (!reportOnly || formPurpose(form) === 'report'))
          .map((form) => `<option value="${form.id}">${escapeHtml(form.name)}</option>`)
      )
      .join('');

    els.workFormSelect.innerHTML = options;
    els.workFormSelect.value = state.workForms.some((form) => (
      String(form.id) === selectedValue
      && form.status === 'active'
      && (!reportOnly || formPurpose(form) === 'report')
    ))
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
      departmentId: state.user.departmentId,
      templatePurpose: formPurpose(form),
      formId: form.id,
      formName: form.name,
      definitionVersion: definitionVersion(form),
      fields: JSON.parse(JSON.stringify(form.fields || [])),
      siteId: els.workFormSite.value || '',
      workDate: els.workFormDate.value || '',
      answers: collectWorkFormAnswers(form, {
        container: els.workFormFields,
        validate: false
      }),
      photoDataUrls: [...state.workFormPhotoDataUrls],
      photoBlobs: [...state.workFormPhotoBlobs],
      photoMetadata: state.workFormPhotoMetadata.map((item) => ({ ...item })),
      savedAt
    };
  }

  function captureVisibleWorkFormDraft() {
    const draftState = activeDraftState();
    if (!draftState || !els.workFormFields.children.length) return null;
    if (conflictingDraft) return draftState.snapshot;
    draftState.snapshot = buildDraftSnapshot(renderedWorkForm, draftState);
    return draftState.snapshot;
  }

  function sameDraftContent(left, right) {
    if (!left || !right) return false;
    return String(left.siteId || '') === String(right.siteId || '')
      && String(left.workDate || '') === String(right.workDate || '')
      && JSON.stringify(left.answers || {}) === JSON.stringify(right.answers || {})
      && JSON.stringify(left.photoMetadata || []) === JSON.stringify(right.photoMetadata || [])
      && (left.photoBlobs || []).length === (right.photoBlobs || []).length
      && (left.photoBlobs || []).every((value, index) => value === right.photoBlobs[index])
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
    if (restoringDraft || conflictingDraft || reloadLocked || state.submittingWorkForm) return;
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
    while (photoProcessing.pending && photoProcessing.key === draftState?.key) {
      const pending = photoProcessing.promise;
      await pending;
      if (pending === photoProcessing.promise) break;
    }
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
        if (!draftState.snapshot) throw new Error('Could not capture this Report draft.');

        const revisionToSave = draftState.revision;
        const savedAt = new Date().toISOString();
        const snapshot = {
          ...draftState.snapshot,
          savedAt
        };
        await saveDraft(draftState.key, snapshot);
        submittedDraftsPendingCleanup.delete(draftState.key);
        draftState.snapshot = snapshot;
        draftState.savedAt = savedAt;
        draftState.savedRevision = revisionToSave;
        draftState.error = null;
      }
    })();

    try {
      await draftState.flushPromise;
      if (activeDraftState()?.key === draftState.key) showSavedStatus(draftState.savedAt);
      void renderDraftList();
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
      throw new Error('Wait for the Report submission to finish.');
    }
    await flushAllDrafts();
    if (hasUnsavedInput()) throw new Error('This Report still has unsaved changes.');
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
        message: 'Wait for the Report submission to finish before updating.'
      };
    }

    try {
      await flushPendingDrafts();
    } catch {
      return {
        safe: false,
        message: 'This Report has changes that are not saved on this device. Updating now could lose them.'
      };
    }

    if (hasUnsavedInput()) {
      showDraftSaveError();
      return {
        safe: false,
        message: 'This Report has changes that are not saved on this device. Updating now could lose them.'
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

  function setDraftConflict(draft) {
    conflictingDraft = draft;
    [els.workFormSite, els.workFormDate, els.workFormPhotos].forEach((control) => {
      control.disabled = Boolean(draft);
    });
    els.submitWorkFormButton.type = draft ? 'button' : 'submit';
    setTranslatableText(els.submitWorkFormButton, draft ? 'Keep draft and start new report' : 'Submit Report');
  }

  function showConflictingDraft(draft, draftState) {
    setDraftConflict(draft);
    draftState.snapshot = draft;
    draftState.savedAt = draft.savedAt || '';
    els.workFormSite.value = draft.siteId || '';
    setDateInputValue(els.workFormDate, draft.workDate || '');
    els.workFormFields.innerHTML = '';
    // Render captured values as text, not editable controls based on a new schema.
    for (const [id, value] of Object.entries(draft.answers || {})) {
      const detail = document.createElement('p');
      const label = draft.fields?.find((field) => field.id === id)?.label || id;
      detail.textContent = `${label}: ${formatWorkFormAnswer(value)}`;
      els.workFormFields.append(detail);
    }
    const signatures = document.createElement('div');
    photoViewer.renderPreviews(signatures, localAnswerImageSources(draft.answers), 'Signature');
    els.workFormFields.append(signatures);
    renderPhotoPreviews(reportPhotoSources(draft), draft.photoMetadata || []);
    setAutosaveStatus('Saved draft is read-only because the Report Template changed.', 'error');
    renderStatusBanner('Report Template changed. Keep this draft in My Reports before starting a new report. Nothing will be submitted automatically.', true, {
      local: els.workFormFeedback,
      tone: 'warning'
    });
  }

  function resetDraftSurface() {
    photoSelectionToken += 1;
    setDraftConflict(null);
    els.workFormSite.value = '';
    setDateInputValue(els.workFormDate, todayDateInput());
    els.workFormPhotos.value = '';
    state.workFormPhotoFiles = [];
    state.workFormPhotoBlobs = [];
    state.workFormPhotoDataUrls = [];
    state.workFormPhotoMetadata = [];
    renderPhotoPreviews([]);
    setPhotoStatus('');
  }

  function photoLimit() {
    return formPurpose(renderedWorkForm) === 'daywork' ? legacyMaxPhotos : maxPhotos;
  }

  function currentPhotoSources() {
    return state.workFormPhotoBlobs.length ? state.workFormPhotoBlobs : state.workFormPhotoDataUrls;
  }

  function renderPhotoPreviews(sources, metadata = []) {
    // Allocate before releasing the old gallery. If URL creation fails, all
    // prior previews and their original evidence remain usable.
    const replacement = createPhotoPreviewSources(sources);
    try {
      photoViewer.renderPreviews(els.workFormPhotoPreview, replacement.urls, 'Report photo', metadata);
    } catch (error) {
      replacement.dispose();
      throw error;
    }
    photoViewer.closeForSources?.(photoPreviewSources.urls, { restoreFocus: false });
    photoPreviewSources.dispose();
    photoPreviewSources = replacement;
  }

  function setPhotoStatus(message) {
    if (els.workFormPhotoStatus) setTranslatableText(els.workFormPhotoStatus, message);
  }

  function updatePhotoRemovalControls() {
    const disabled = Boolean(conflictingDraft || reloadLocked || state.submittingWorkForm || photoProcessing.pending);
    els.workFormPhotoPreview.querySelectorAll('[data-remove-report-photo]').forEach((button) => {
      button.disabled = disabled;
    });
    if (els.workFormPhotoLimit) {
      setTranslatableText(els.workFormPhotoLimit, `Up to ${photoLimit()} photos. You can select them together.`);
    }
    if (!state.submittingWorkForm && (!photoProcessing.pending || photoProcessing.key !== activeDraftState()?.key)) {
      setPhotoStatus(`${currentPhotoSources().length} of ${photoLimit()} photos selected.`);
    }
  }

  function renderEditablePhotoPreviews(sources = currentPhotoSources(), metadata = state.workFormPhotoMetadata) {
    renderPhotoPreviews(
      sources,
      metadata
    );
    els.workFormPhotoPreview.querySelectorAll('.photo-thumb').forEach((preview, index) => {
      const item = document.createElement('div');
      item.className = 'report-photo-item';
      preview.replaceWith(item);
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'ghost report-photo-remove';
      removeButton.dataset.removeReportPhoto = String(index);
      removeButton.setAttribute('aria-label', `Remove photo ${index + 1}`);
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        if (!removeButton.isConnected || conflictingDraft || reloadLocked || state.submittingWorkForm || photoProcessing.pending) return;
        const exceptRemoved = (_, sourceIndex) => sourceIndex !== index;
        const nextFiles = state.workFormPhotoFiles.filter(exceptRemoved);
        const nextBlobs = state.workFormPhotoBlobs.filter(exceptRemoved);
        const nextDataUrls = state.workFormPhotoDataUrls.filter(exceptRemoved);
        const nextMetadata = state.workFormPhotoMetadata.filter(exceptRemoved);
        try {
          renderEditablePhotoPreviews(state.workFormPhotoBlobs.length ? nextBlobs : nextDataUrls, nextMetadata);
        } catch {
          renderStatusBanner('Could not remove this photo. Your photos have not changed. Try again.', true, {
            local: els.workFormFeedback,
            tone: 'error'
          });
          return;
        }
        state.workFormPhotoFiles = nextFiles;
        state.workFormPhotoBlobs = nextBlobs;
        state.workFormPhotoDataUrls = nextDataUrls;
        state.workFormPhotoMetadata = nextMetadata;
        els.workFormPhotos.value = '';
        feedback.clearLocal(els.workFormFeedback);
        markActiveDraftDirty();
        updatePhotoRemovalControls();
        const nextIndex = Math.min(index, currentPhotoSources().length - 1);
        const nextButton = els.workFormPhotoPreview.querySelector(`[data-remove-report-photo="${nextIndex}"]`);
        (nextButton || els.workFormPhotos).focus();
      });
      item.append(preview, removeButton);
    });
    updatePhotoRemovalControls();
  }

  function validStoredDraft(value, form, draftState) {
    if (submittedDraftsPendingCleanup.has(draftState.key)) return false;
    if (reportOnly) return isReportDraftForWorker(value, state.user, form);
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
      state.workFormPhotoBlobs = Array.isArray(draft.photoBlobs) ? [...draft.photoBlobs] : [];
      state.workFormPhotoDataUrls = Array.isArray(draft.photoDataUrls) ? [...draft.photoDataUrls] : [];
      state.workFormPhotoMetadata = Array.isArray(draft.photoMetadata)
        ? draft.photoMetadata.map((item) => ({ ...item }))
        : [];
      renderEditablePhotoPreviews();
      draftState.snapshot = {
        ...draft,
        photoBlobs: [...state.workFormPhotoBlobs],
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

    const draftVersion = draft.definitionVersion == null
      ? 1
      : ['number', 'string'].includes(typeof draft.definitionVersion) ? Number(draft.definitionVersion) : NaN;
    if (formPurpose(form) === 'report' && (
      !Number.isSafeInteger(draftVersion) || draftVersion <= 0 || draftVersion !== definitionVersion(form)
    )) {
      showConflictingDraft(draft, draftState);
      return;
    }

    if (formPurpose(form) === 'report') {
      try {
        draft = restoreReportPhotoEvidence(draft);
      } catch (error) {
        draftState.error = error;
        showConflictingDraft(draft, draftState);
        showDraftSaveError();
        return;
      }
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
      renderStatusBanner('This draft was saved with an earlier Report Template version. Review it before submitting.', true, {
        local: els.workFormFeedback,
        tone: 'warning'
      });
    }
  }

  async function renderSelectedWorkForm(options = {}) {
    // A selection/revalidation can already be awaiting a draft commit when
    // Submit or Update acquires the editor. Only their own completed-operation
    // reset (skipFlush) may replace that locked surface.
    const externallyLocked = () => options.skipFlush !== true && (reloadLocked || state.submittingWorkForm);
    if (externallyLocked()) return;
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
    if (token !== selectionToken || externallyLocked()) return;

    const form = selectedWorkForm(requestedFormId);
    resetDraftSurface();
    renderWorkFormFields(els.workFormFields, form, { container: els.workFormFields });
    renderedWorkForm = form || null;
    updatePhotoRemovalControls();
    showDefaultAutosaveStatus();
    if (!form || state.user?.role !== 'worker') return;

    const draftState = draftStateFor(form);
    await restoreSelectedDraft(form, draftState, token);
  }

  function setReportTemplateSource(source, savedAt = '') {
    reportTemplateSource = source;
    reportTemplatesSavedAt = savedAt;
    onReportTemplateSourceChanged({
      source,
      savedAt,
      templateCount: state.workForms.filter((form) => form.status === 'active' && formPurpose(form) === 'report').length
    });
  }

  async function applyRefreshedWorkForms(workForms, isCurrentSession) {
    // A refresh may replace the Definition used by the visible Report. Save the
    // original fields/answers/evidence before the existing version guard runs.
    if (state.user?.role === 'worker') {
      if (reloadLocked || state.submittingWorkForm) return false;
      try {
        await flushPendingDrafts();
      } catch {
        if (isCurrentSession()) renderStatusBanner('Report Templates were not refreshed because this Report has unsaved changes. Keep this page open and try again.', true, {
          local: els.workFormFeedback,
          tone: 'error'
        });
        return false;
      }
    }
    if (!isCurrentSession() || reloadLocked || state.submittingWorkForm) return false;
    state.workForms = workForms;
    renderWorkFormOptions();
    await renderSelectedWorkForm({ preserveCurrent: false });
    if (!isCurrentSession()) return false;
    onWorkFormsChanged();
    void renderDraftList();
    if (state.user.role === 'supervisor') onSupervisorWorkFormsChanged();
    return true;
  }

  async function refreshWorkForms() {
    if (!state.user) return false;
    const requestUser = { ...state.user };
    const requestGeneration = sessionGeneration;
    const request = ++templateRequest;
    const isReportWorker = reportOnly && requestUser.role === 'worker';
    const isCurrentSession = () => (
      requestGeneration === sessionGeneration
      && request === templateRequest
      && state.user?.role === requestUser.role
      && String(state.user?.id || '') === String(requestUser.id)
      && String(state.user?.departmentId || '') === String(requestUser.departmentId || '')
    );

    let workForms;
    try {
      workForms = await getBackendWorkForms(reportOnly ? 'report' : '');
    } catch (error) {
      if (!isCurrentSession()) return false;
      if (isBackendSessionError(error)) {
        if (isReportWorker) void clearWorkerReportTemplateSnapshot(requestUser).catch(() => {});
        state.workForms = [];
        renderWorkFormOptions();
        setReportTemplateSource('unavailable');
        handleSessionExpired();
        return false;
      }
      if (isReportWorker) {
        try {
          const snapshot = await loadWorkerReportTemplateSnapshot(requestUser);
          if (!isCurrentSession()) return false;
          if (snapshot) {
            if (!await applyRefreshedWorkForms(snapshot.templates, isCurrentSession)) return false;
            setReportTemplateSource('offline', snapshot.savedAt);
            return true;
          }
        } catch {
          // Storage failure cannot prevent editing an already-loaded Template.
        }
        if (!isCurrentSession()) return false;
        if (reportTemplateSource !== 'unavailable' && state.workForms.length) {
          setReportTemplateSource('offline', reportTemplatesSavedAt);
          return true;
        }
      }
      if (state.user.role === 'worker') {
        state.workForms = [];
        renderWorkFormOptions();
        setReportTemplateSource('unavailable');
        renderStatusBanner(error.message || 'Could not load Report Templates.', true);
        void renderDraftList();
      }
      return false;
    }
    if (!isCurrentSession()) return false;
    if (!await applyRefreshedWorkForms(workForms, isCurrentSession)) return false;
    let savedAt = '';
    if (isReportWorker) {
      try {
        if (await saveWorkerReportTemplateSnapshot(requestUser, workForms, { isCurrent: isCurrentSession })) {
          savedAt = new Date().toISOString();
        }
      } catch {
        // Current authenticated Templates remain usable when device storage fails.
      }
    }
    if (!isCurrentSession()) return false;
    setReportTemplateSource(isReportWorker && !navigator.onLine ? 'offline' : 'online', savedAt);
    return true;
  }

  function hasOfflineTemplates() {
    return reportOnly && state.user?.role === 'worker' && reportTemplateSource === 'offline';
  }

  async function refreshAfterReconnect() {
    return hasOfflineTemplates() ? refreshWorkForms() : false;
  }

  function draftScopeStillActive(worker, generation) {
    return generation === sessionGeneration
      && state.user?.role === 'worker'
      && String(state.user.id) === String(worker.id)
      && String(state.user.departmentId || '') === String(worker.departmentId || '');
  }

  async function renderDraftList({ flush = false } = {}) {
    if (!reportOnly || !els.reportDraftsPanel) return;
    const request = ++draftListRequest;
    const worker = state.user;
    const generation = sessionGeneration;
    if (worker?.role !== 'worker') {
      els.reportDraftsPanel.hidden = true;
      els.reportDraftsList.replaceChildren();
      return;
    }
    const isCurrent = () => request === draftListRequest && draftScopeStillActive(worker, generation);
    try {
      if (flush) await flushPendingDrafts();
      if (!isCurrent()) return;
      const entries = await getDraftEntries();
      if (!isCurrent()) return;
      const drafts = summarizeReportDrafts(
        entries.filter((entry) => !submittedDraftsPendingCleanup.has(entry?.key)),
        worker,
        state.workForms
      );
      els.reportDraftsPanel.hidden = drafts.length === 0;
      els.reportDraftsList.replaceChildren();
      for (const draft of drafts) {
        const card = document.createElement('article');
        card.className = 'report-draft-card';
        card.innerHTML = `
          <div class="report-draft-summary">
            <h4 data-no-i18n>${escapeHtml(draft.formName)}</h4>
            <p><span>Report Date</span>: <span data-no-i18n>${escapeHtml(draft.workDate || '-')}</span></p>
            <p><span>Last saved</span>: <span data-no-i18n>${escapeHtml(formatDateTime(draft.savedAt))}</span></p>
            ${draft.availability === 'template_changed' ? '<p class="muted">Report Template changed. Review the saved draft before starting a new Report.</p>' : ''}
            ${draft.availability === 'unavailable' ? '<p class="muted">Report Template unavailable. Connect and refresh, or ask your supervisor.</p>' : ''}
          </div>`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Continue draft';
        button.disabled = draft.availability === 'unavailable';
        button.addEventListener('click', async () => {
          if (draftContinueInFlight) return;
          feedback.setButtonBusy(button, true, 'Opening draft...');
          try {
            await continueReportDraft(draft.formId);
          } finally {
            if (button.isConnected) feedback.setButtonBusy(button, false);
          }
        });
        card.append(button);
        els.reportDraftsList.append(card);
      }
    } catch {
      if (!isCurrent()) return;
      els.reportDraftsPanel.hidden = false;
      els.reportDraftsList.textContent = 'Could not load saved drafts. Keep New Report open if changes are not saved, then try Refresh.';
    }
  }

  async function continueReportDraft(formId) {
    if (!reportOnly || state.user?.role !== 'worker' || draftContinueInFlight || reloadLocked || state.submittingWorkForm) return false;
    const worker = state.user;
    const generation = sessionGeneration;
    draftContinueInFlight = true;
    try {
      await flushPendingDrafts();
      if (!draftScopeStillActive(worker, generation)) return false;
      const form = selectedWorkForm(formId);
      const key = workFormDraftKey(worker.id, formId);
      const draft = await getDraft(key);
      if (!draftScopeStillActive(worker, generation)) return false;
      if (submittedDraftsPendingCleanup.has(key) || !isReportDraftForWorker(draft, worker, form)) {
        void renderDraftList();
        renderStatusBanner('This draft cannot be opened with the available Report Templates. Your saved work is unchanged.', true);
        return false;
      }
      els.workFormSelect.value = String(form.id);
      await renderSelectedWorkForm();
      if (!draftScopeStillActive(worker, generation) || String(renderedWorkForm?.id) !== String(formId)) return false;
      onContinueDraft();
      els.workFormSelect.focus();
      els.workFormSelect.scrollIntoView({ block: 'start' });
      return true;
    } catch {
      if (draftScopeStillActive(worker, generation)) {
        renderStatusBanner('Could not open this draft. Keep New Report open if changes are not saved, then try again.', true);
      }
      return false;
    } finally {
      if (generation === sessionGeneration) draftContinueInFlight = false;
    }
  }

  async function processPhotoChange(selectedFiles, token, draftState) {
    const isCurrent = () => token === photoSelectionToken && activeDraftState()?.key === draftState?.key;
    if (!isCurrent()) return;
    const limit = photoLimit();
    const remainingSlots = Math.max(0, limit - currentPhotoSources().length);
    const files = selectedFiles.slice(0, remainingSlots);
    const validationError = files.map(uploadImageValidationError).find(Boolean);
    if (validationError) {
      renderStatusBanner(validationError, true, {
        local: els.workFormFeedback,
        field: els.workFormPhotos,
        tone: 'error'
      });
      return;
    }

    try {
      const useBlobs = formPurpose(renderedWorkForm) === 'report';
      const dataUrls = [];
      // Reports keep exact File bytes; retained Daywork reads sequentially.
      // Append atomically only after the replacement gallery is available.
      for (const [index, file] of files.entries()) {
        if (!isCurrent()) return;
        setPhotoStatus(`Preparing photo ${index + 1} of ${files.length}...`);
        if (!useBlobs) dataUrls.push(await fileToDataUrl(file));
      }
      if (!isCurrent()) return;
      // Keep the retained Daywork File fast path only for a complete set.
      const existingCount = currentPhotoSources().length;
      const nextFiles = state.workFormPhotoFiles.length === existingCount
        ? [...state.workFormPhotoFiles, ...files]
        : [];
      const nextMetadata = [
        ...currentPhotoSources().map((_, index) => state.workFormPhotoMetadata[index] || {}),
        ...files.map(photoMetadataFromFile)
      ];
      const nextDataUrls = [...state.workFormPhotoDataUrls, ...dataUrls];
      const nextBlobs = useBlobs ? [...state.workFormPhotoBlobs, ...files] : [];
      renderEditablePhotoPreviews(useBlobs ? nextBlobs : nextDataUrls, nextMetadata);
      state.workFormPhotoFiles = nextFiles;
      state.workFormPhotoMetadata = nextMetadata;
      state.workFormPhotoDataUrls = nextDataUrls;
      state.workFormPhotoBlobs = nextBlobs;
      updatePhotoRemovalControls();
      feedback.clearLocal(els.workFormFeedback);

      if (selectedFiles.length > remainingSlots) {
        renderStatusBanner(`Reports can include up to ${limit} photos. The first ${limit} were kept.`, true, {
          local: els.workFormFeedback,
          tone: 'warning'
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      renderStatusBanner('Could not prepare these photos. Choose them again before leaving this page.', true, {
        local: els.workFormFeedback,
        field: els.workFormPhotos,
        tone: 'error'
      });
      throw error;
    }
  }

  function handlePhotoChange(event) {
    if (conflictingDraft || reloadLocked || state.submittingWorkForm) return;
    const draftState = activeDraftState();
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!draftState || !files.length) return;
    markActiveDraftDirty({ capture: false });
    const token = photoSelectionToken;
    // Complete selections in order. A second picker event must not cancel an
    // earlier read, and both belong to the same guarded Worker/Template surface.
    const promise = photoProcessing.promise.catch(() => {}).then(() => processPhotoChange(files, token, draftState));
    photoProcessing = {
      key: draftState?.key || '',
      pending: true,
      error: null,
      promise
    };
    updatePhotoRemovalControls();
    void promise
      .catch((error) => {
        if (photoProcessing.promise === promise) photoProcessing.error = error;
        if (activeDraftState()?.key === draftState?.key) showDraftSaveError();
      })
      .finally(() => {
        if (photoProcessing.promise === promise) {
          photoProcessing.pending = false;
          updatePhotoRemovalControls();
        }
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
    feedback.setButtonBusy(els.submitWorkFormButton, isSubmitting, 'Submitting Report...');
    state.submittingWorkForm = isSubmitting;
    els.submitWorkFormButton.disabled = isSubmitting;
    updatePhotoRemovalControls();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingWorkForm) return;
    if (conflictingDraft) {
      await keepConflictingDraft();
      return;
    }

    const form = renderedWorkForm?.id === selectedWorkForm()?.id ? renderedWorkForm : null;
    if (!form) {
      renderStatusBanner('Choose a Report Template first.', true, {
        local: els.workFormFeedback,
        field: els.workFormSelect,
        tone: 'error'
      });
      return;
    }

    if (!els.workFormDate.value) {
      renderStatusBanner('Report Date is required.', true, {
        local: els.workFormFeedback,
        field: els.workFormDate,
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
    const submittedSessionGeneration = sessionGeneration;
    const submittedWorker = { id: state.user.id, name: state.user.fullName };
    const isCurrentSubmission = () => sessionGeneration === submittedSessionGeneration
      && state.user?.role === 'worker'
      && String(state.user.id) === String(submittedWorker.id);
    try {
      await waitForDraftPhotos(submittedDraft);
      if (!isCurrentSubmission()) return;
      try {
        await flushActiveDraft();
      } catch {
        // A successful submission is also a durable way to protect the current work.
      }
      if (!isCurrentSubmission()) return;
      const answers = await collectWorkFormAnswers(form, { container: els.workFormFields });
      if (!isCurrentSubmission()) return;

      const localRecord = {
        id: uuid(),
        type: 'form',
        formId: form.id,
        formName: form.name,
        definitionVersion: definitionVersion(form),
        submissionPurpose: formPurpose(form),
        fields: form.fields || [],
        userId: submittedWorker.id,
        userName: submittedWorker.name,
        siteId: site?.id || null,
        siteName: site?.name || 'Unassigned site',
        workDate: els.workFormDate.value,
        answers,
        photoDataUrls: [...state.workFormPhotoDataUrls],
        photoBlobs: [...state.workFormPhotoBlobs],
        photoMetadata: state.workFormPhotoMetadata.map((item) => ({ ...item })),
        photoUrls: [],
        createdAt: new Date().toISOString()
      };

      const result = await submitOfflineSubmission(localRecord, {
        draftKey: submittedDraft.key,
        photoFiles: state.workFormPhotoFiles,
        onUploadProgress: ({ phase, completed, total, retryAfterSeconds }) => {
          if (!isCurrentSubmission() || !state.submittingWorkForm) return;
          setPhotoStatus(phase === 'waiting'
            ? `Upload limit reached. Retrying in ${retryAfterSeconds} seconds. ${completed} of ${total} photos and signatures uploaded.`
            : phase === 'submitting'
              ? 'Uploads saved. Finishing submission...'
            : `Uploading photos and signatures: ${completed} of ${total}. Keep this page open.`);
        }
      });
      if (!isCurrentSubmission()) return;

      if (result.draftCleanupFailed) submittedDraftsPendingCleanup.add(submittedDraft.key);
      cancelAutosaveTimer();
      draftStates.delete(submittedDraft.key);
      els.workFormSubmissionForm.reset();
      setDateInputValue(els.workFormDate, todayDateInput());
      state.workFormPhotoFiles = [];
      state.workFormPhotoBlobs = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      renderPhotoPreviews([]);
      await renderSelectedWorkForm({ preserveCurrent: false, skipFlush: true });
      if (!isCurrentSubmission()) return;
      await syncQueueIfPossible(!result.offline);
      if (!isCurrentSubmission()) return;
      const submissionMessage = reportOnly
        ? result.message.replace(/ submitted for approval\.$/, ' submitted for review.')
        : result.message;
      const resultMessage = result.draftCleanupFailed
        ? `${submissionMessage} The submitted draft could not be cleared from this device; do not submit it again after reloading.`
        : submissionMessage;
      renderStatusBanner(resultMessage, result.offline || result.draftCleanupFailed, {
        local: els.workFormFeedback,
        tone: result.offline || result.draftCleanupFailed ? 'warning' : 'success'
      });
      await renderWorkerSummary();
      if (!isCurrentSubmission()) return;
      await renderHistory();
      if (!isCurrentSubmission()) return;
      void renderDraftList();
    } catch (error) {
      if (!isCurrentSubmission()) return;
      setSubmitting(false);
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      const invalidField = error.fieldId ? document.getElementById(error.fieldId) : null;
      renderStatusBanner(error.message || 'Could not submit Report.', true, {
        local: els.workFormFeedback,
        field: invalidField,
        tone: 'error'
      });
    } finally {
      if (isCurrentSubmission() && state.submittingWorkForm) setSubmitting(false);
    }
  }

  function handleDraftMutation(event) {
    if (event.target === els.workFormSelect || event.target === els.workFormPhotos) return;
    markActiveDraftDirty();
  }

  async function keepConflictingDraft() {
    if (!conflictingDraft || state.submittingWorkForm || reloadLocked) return;
    const draft = conflictingDraft;
    const draftState = activeDraftState();
    const generation = sessionGeneration;
    if (!draftState) return;
    setSubmitting(true);
    try {
      draftState.recoveryRecordId ||= uuid();
      const result = await preserveConflictingReportDraft({
        id: draftState.recoveryRecordId,
        type: 'form',
        ownerWorkerId: draftState.ownerWorkerId,
        formId: draft.formId,
        formName: draft.formName || renderedWorkForm.name,
        submissionPurpose: 'report',
        definitionVersion: draft.definitionVersion ?? null,
        fields: draft.fields || [],
        answers: draft.answers || {},
        siteId: draft.siteId || null,
        siteName: draft.siteId ? findSiteByFormValue(draft.siteId)?.name || String(draft.siteId) : 'Unassigned site',
        workDate: draft.workDate || '',
        photoDataUrls: draft.photoDataUrls || [],
        photoBlobs: draft.photoBlobs || [],
        photoMetadata: draft.photoMetadata || [],
        createdAt: new Date().toISOString()
      }, draftState.key);
      if (generation !== sessionGeneration) return;
      if (result.draftCleanupFailed) throw new Error('The saved copy is in My Reports, but the draft could not be cleared. Keep this page open and try again.');
      setSubmitting(false);
      draftStates.delete(draftState.key);
      await renderSelectedWorkForm({ preserveCurrent: false, skipFlush: true });
      if (generation !== sessionGeneration) return;
      renderStatusBanner('Original draft kept in My Reports. Complete a new report with the current template.', true, {
        local: els.workFormFeedback,
        tone: 'warning'
      });
      await renderHistory();
      void renderDraftList();
    } catch (error) {
      if (generation === sessionGeneration) renderStatusBanner(error.message || 'Could not keep this Report draft. The original draft is unchanged.', true, {
        local: els.workFormFeedback,
        tone: 'error'
      });
    } finally {
      if (generation === sessionGeneration && state.submittingWorkForm) setSubmitting(false);
    }
  }

  function bindEvents() {
    els.workFormSubmissionForm.addEventListener('submit', handleSubmit);
    els.submitWorkFormButton.addEventListener('click', () => {
      if (conflictingDraft) void keepConflictingDraft();
    });
    els.workFormSelect.addEventListener('change', () => {
      void renderSelectedWorkForm();
    });
    els.workFormPhotos.addEventListener('change', handlePhotoChange);
    els.refreshHistoryButton.addEventListener('click', () => { void renderDraftList({ flush: true }); });
    els.workFormSubmissionForm.addEventListener('input', handleDraftMutation);
    els.workFormSubmissionForm.addEventListener('change', handleDraftMutation);
    window.addEventListener('offline', () => {
      if (reportOnly && state.user?.role === 'worker' && reportTemplateSource === 'online') {
        setReportTemplateSource('offline', reportTemplatesSavedAt);
      }
    });
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
    sessionGeneration += 1;
    templateRequest += 1;
    draftListRequest += 1;
    draftContinueInFlight = false;
    if (els.reportDraftsPanel) {
      els.reportDraftsPanel.hidden = true;
      els.reportDraftsList.replaceChildren();
    }
    if (state.submittingWorkForm || submissionControlStates.length) setSubmitting(false);
    feedback.clearLocal(els.workFormFeedback);
    cancelAutosaveTimer();
    selectionToken += 1;
    photoSelectionToken += 1;
    renderedWorkForm = null;
    restoringDraft = false;
    setDraftConflict(null);
    reloadLocked = false;
    els.workFormSubmissionForm.inert = false;
    els.workFormSubmissionForm.removeAttribute('aria-busy');
    els.workFormFields.inert = false;
    submissionControlStates = [];
    els.workFormSubmissionForm.reset();
    state.workForms = [];
    setReportTemplateSource('unavailable');
    els.workFormSelect.innerHTML = `<option value="">${emptyTemplateOption}</option>`;
    setDateInputValue(els.workFormDate, todayDateInput());
    els.workFormFields.innerHTML = '';
    state.workFormPhotoFiles = [];
    state.workFormPhotoBlobs = [];
    state.workFormPhotoDataUrls = [];
    state.workFormPhotoMetadata = [];
    renderPhotoPreviews([]);
    photoProcessing = { key: '', pending: false, error: null, promise: Promise.resolve() };
    setPhotoStatus('');
    draftStates.clear();
    submittedDraftsPendingCleanup.clear();
    showDefaultAutosaveStatus();
  }

  return {
    bindEvents,
    cancelAppUpdatePreparation,
    clearSessionState,
    focusUnsavedInput,
    flushPendingDrafts,
    hasUnsavedInput,
    hasOfflineTemplates,
    prepareForAppUpdate,
    refreshAfterReconnect,
    refreshWorkForms,
    renderDraftList,
    renderSelectedWorkForm
  };
}
