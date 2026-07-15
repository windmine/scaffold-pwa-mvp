import { getWorkForms as getBackendWorkForms } from './api-client.js';
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

export function createWorkerFormModule({
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
  isBackendSessionError,
  onSupervisorWorkFormsChanged = () => {},
  onWorkFormsChanged = () => {}
}) {
  let renderedWorkForm = null;
  let inProgressDraft = null;

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

  function selectedWorkForm() {
    return state.workForms.find((form) => String(form.id) === String(els.workFormSelect.value));
  }

  function captureVisibleWorkFormDraft() {
    if (!renderedWorkForm || !els.workFormFields.children.length || state.user?.role !== 'worker') return;

    try {
      inProgressDraft = {
        ownerWorkerId: state.user.id,
        formId: renderedWorkForm.id,
        answers: collectWorkFormAnswers(renderedWorkForm, {
          container: els.workFormFields,
          validate: false
        })
      };
    } catch {
      // Keep the last collectable answers if a live Definition changes during refresh.
    }
  }

  function renderSelectedWorkForm(options = {}) {
    if (options.preserveCurrent !== false) captureVisibleWorkFormDraft();
    const form = selectedWorkForm();
    renderWorkFormFields(els.workFormFields, form, { container: els.workFormFields });
    renderedWorkForm = form || null;

    if (
      form
      && String(inProgressDraft?.ownerWorkerId || '') === String(state.user?.id || '')
      && String(inProgressDraft?.formId || '') === String(form.id)
    ) {
      populateWorkFormAnswers(form, inProgressDraft.answers || {}, { container: els.workFormFields });
    }
  }

  async function refreshWorkForms() {
    if (!state.user) return;
    const requestUserId = state.user.id;

    try {
      const workForms = await getBackendWorkForms();
      if (String(state.user?.id || '') !== String(requestUserId)) return;
      captureVisibleWorkFormDraft();
      state.workForms = workForms;
      renderWorkFormOptions();
      renderSelectedWorkForm({ preserveCurrent: false });
      onWorkFormsChanged();
      if (state.user.role === 'supervisor') {
        onSupervisorWorkFormsChanged();
      }
    } catch (error) {
      if (String(state.user?.id || '') !== String(requestUserId)) return;
      state.workForms = [];
      renderWorkFormOptions();
      if (state.user.role === 'worker') {
        renderStatusBanner(error.message || 'Could not load work forms.', true);
      }
    }
  }

  async function handlePhotoChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    const files = selectedFiles.slice(0, maxPhotos);
    const validationError = files.map(uploadImageValidationError).find(Boolean);
    if (validationError) {
      event.target.value = '';
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
      renderStatusBanner(validationError, true);
      return;
    }
    state.workFormPhotoFiles = files;
    state.workFormPhotoDataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
    state.workFormPhotoMetadata = files.map(photoMetadataFromFile);
    photoViewer.renderPreviews(els.workFormPhotoPreview, state.workFormPhotoDataUrls, 'Form photo', state.workFormPhotoMetadata);

    if (selectedFiles.length > maxPhotos) {
      renderStatusBanner(`Form submissions can include up to ${maxPhotos} photos. The first ${maxPhotos} were kept.`, true);
    }
  }

  function setSubmitting(isSubmitting) {
    state.submittingWorkForm = isSubmitting;
    els.submitWorkFormButton.disabled = isSubmitting;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingWorkForm) return;

    const form = selectedWorkForm();
    if (!form) {
      renderStatusBanner('Choose a form first.', true);
      return;
    }

    const site = els.workFormSite.value ? findSiteByFormValue(els.workFormSite.value) : null;
    if (els.workFormSite.value && !site) {
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
        draftKey: null,
        photoFiles: state.workFormPhotoFiles
      });

      els.workFormSubmissionForm.reset();
      setDateInputValue(els.workFormDate, todayDateInput());
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      inProgressDraft = null;
      photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
      renderSelectedWorkForm({ preserveCurrent: false });
      await syncQueueIfPossible(!result.offline);
      renderStatusBanner(result.message, result.offline);
      await renderWorkerSummary();
      await renderHistory();
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not submit form.', true);
    } finally {
      setSubmitting(false);
    }
  }

  function bindEvents() {
    els.workFormSubmissionForm.addEventListener('submit', handleSubmit);
    els.workFormSelect.addEventListener('change', renderSelectedWorkForm);
    els.workFormPhotos.addEventListener('change', handlePhotoChange);
  }

  function clearSessionState() {
    renderedWorkForm = null;
    inProgressDraft = null;
    els.workFormSubmissionForm.reset();
    els.workFormSelect.innerHTML = '<option value="">Select a form</option>';
    setDateInputValue(els.workFormDate, todayDateInput());
    els.workFormFields.innerHTML = '';
    state.workFormPhotoFiles = [];
    state.workFormPhotoDataUrls = [];
    state.workFormPhotoMetadata = [];
    photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
  }

  return {
    bindEvents,
    clearSessionState,
    refreshWorkForms,
    renderSelectedWorkForm
  };
}
