import { getWorkForms as getBackendWorkForms } from './api-client.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { collectWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { fileToDataUrl, todayDateInput, uuid, escapeHtml, photoMetadataFromFile } from './utils.js';

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

  function renderSelectedWorkForm() {
    renderWorkFormFields(els.workFormFields, selectedWorkForm(), { container: els.workFormFields });
  }

  async function refreshWorkForms() {
    if (!state.user) return;

    try {
      state.workForms = await getBackendWorkForms();
      renderWorkFormOptions();
      renderSelectedWorkForm();
      onWorkFormsChanged();
      if (state.user.role === 'supervisor') {
        onSupervisorWorkFormsChanged();
      }
    } catch (error) {
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
      els.workFormDate.value = todayDateInput();
      state.workFormPhotoFiles = [];
      state.workFormPhotoDataUrls = [];
      state.workFormPhotoMetadata = [];
      photoViewer.renderPreviews(els.workFormPhotoPreview, [], 'Form photo');
      renderSelectedWorkForm();
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

  return {
    bindEvents,
    refreshWorkForms,
    renderSelectedWorkForm
  };
}
