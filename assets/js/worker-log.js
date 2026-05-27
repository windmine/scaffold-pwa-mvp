import {
  createTaskTemplate as createBackendTaskTemplate,
  deleteTaskTemplate as deleteBackendTaskTemplate,
  getTaskTemplates as getBackendTaskTemplates
} from './api-client.js';
import { saveDraft } from './mock-api.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { fileToDataUrl, todayDateInput, uuid, escapeHtml } from './utils.js';

function getBackendSiteId(siteId) {
  if (!siteId) return null;

  const directId = Number(siteId);
  return Number.isInteger(directId) ? directId : null;
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
  function setSubmitting(isSubmitting) {
    state.submittingTask = isSubmitting;
    els.submitTaskButton.disabled = isSubmitting;
    els.saveTaskDraftButton.disabled = isSubmitting;
  }

  async function persistDraft() {
    await saveDraft('task-form', {
      siteId: els.taskSite.value,
      workDate: els.taskDate.value,
      hoursWorked: els.taskHours.value,
      summary: els.taskSummary.value,
      safetyNotes: els.taskSafety.value,
      photoDataUrl: state.taskPhotoDataUrls[0] || '',
      photoDataUrls: state.taskPhotoDataUrls
    });
    renderStatusBanner('Task log draft saved on this device.');
  }

  async function handlePhotoChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    const files = selectedFiles.slice(0, maxPhotos);
    state.taskPhotoFiles = files;
    state.taskPhotoDataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Task photo');
    await persistDraft();
    if (selectedFiles.length > maxPhotos) {
      renderStatusBanner(`Task logs can include up to ${maxPhotos} photos. The first ${maxPhotos} were kept.`, true);
    }
  }

  function resetForm() {
    els.taskSite.value = '';
    els.taskDate.value = todayDateInput();
    els.taskHours.value = '';
    els.taskSummary.value = '';
    els.taskSafety.value = '';
    els.taskPhoto.value = '';
    state.taskPhotoDataUrls = [];
    state.taskPhotoFiles = [];
    photoViewer.renderPreviews(els.taskPhotoPreview, [], 'Task photo');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user) return;
    if (!els.taskSite.value || !els.taskDate.value || !els.taskSummary.value.trim()) {
      renderStatusBanner('Site, work date, and task summary are required.');
      return;
    }

    const site = findSiteByFormValue(els.taskSite.value);
    if (!site) {
      renderStatusBanner('Please select a valid site first.');
      return;
    }

    if (state.submittingTask) return;
    setSubmitting(true);

    try {
      const localRecord = {
        id: uuid(),
        type: 'task',
        userId: state.user.id,
        userName: state.user.fullName,
        siteId: site.id,
        siteName: site.name,
        workDate: els.taskDate.value,
        hoursWorked: els.taskHours.value,
        summary: els.taskSummary.value.trim(),
        safetyNotes: els.taskSafety.value.trim(),
        photoDataUrl: state.taskPhotoDataUrls[0] || '',
        photoDataUrls: state.taskPhotoDataUrls,
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
      renderStatusBanner(error.message || 'Could not submit task log.', true);
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshTaskTemplates() {
    if (!state.user || state.user.role !== 'worker') return;

    try {
      state.taskTemplates = await getBackendTaskTemplates();
      renderTaskTemplateOptions();
    } catch {
      state.taskTemplates = [];
      renderTaskTemplateOptions();
    }
  }

  function renderTaskTemplateOptions() {
    const selectedValue = els.taskTemplateSelect.value;
    const options = ['<option value="">No template selected</option>']
      .concat(
        state.taskTemplates.map((template) => (
          `<option value="${template.id}">${escapeHtml(template.name)}${template.site_name ? ` - ${escapeHtml(template.site_name)}` : ''}</option>`
        ))
      )
      .join('');

    els.taskTemplateSelect.innerHTML = options;
    els.taskTemplateSelect.value = state.taskTemplates.some((template) => String(template.id) === selectedValue)
      ? selectedValue
      : '';
  }

  function selectedTaskTemplate() {
    return state.taskTemplates.find((template) => String(template.id) === String(els.taskTemplateSelect.value));
  }

  async function applySelectedTaskTemplate() {
    const template = selectedTaskTemplate();
    if (!template) {
      renderStatusBanner('Choose a task template first.', true);
      return;
    }

    els.taskSite.value = template.site_id || '';
    els.taskHours.value = template.hours_worked ?? '';
    els.taskSummary.value = template.description || '';
    els.taskSafety.value = template.safety_notes || '';
    await persistDraft();
    renderStatusBanner(`Template "${template.name}" applied.`);
  }

  async function saveCurrentTaskTemplate() {
    const name = els.taskTemplateNameInput.value.trim();
    const summary = els.taskSummary.value.trim();

    if (!name || !summary) {
      renderStatusBanner('Template name and task summary are required.', true);
      return;
    }

    try {
      await createBackendTaskTemplate({
        name,
        site_id: getBackendSiteId(els.taskSite.value),
        description: summary,
        hours_worked: els.taskHours.value ? Number(els.taskHours.value) : null,
        safety_notes: els.taskSafety.value.trim() || null
      });
      els.taskTemplateNameInput.value = '';
      await refreshTaskTemplates();
      renderStatusBanner('Task template saved.');
    } catch (error) {
      renderStatusBanner(error.message || 'Could not save task template.', true);
    }
  }

  async function deleteSelectedTaskTemplate() {
    const template = selectedTaskTemplate();
    if (!template) {
      renderStatusBanner('Choose a task template to delete.', true);
      return;
    }

    if (!window.confirm(`Delete template "${template.name}"?`)) return;

    try {
      await deleteBackendTaskTemplate(template.id);
      await refreshTaskTemplates();
      renderStatusBanner('Task template deleted.');
    } catch (error) {
      renderStatusBanner(error.message || 'Could not delete task template.', true);
    }
  }

  function restoreDraft(taskDraft) {
    if (!taskDraft) return;

    els.taskSite.value = taskDraft.siteId || '';
    els.taskDate.value = taskDraft.workDate || todayDateInput();
    els.taskHours.value = taskDraft.hoursWorked || '';
    els.taskSummary.value = taskDraft.summary || '';
    els.taskSafety.value = taskDraft.safetyNotes || '';
    state.taskPhotoDataUrls = taskDraft.photoDataUrls || (taskDraft.photoDataUrl ? [taskDraft.photoDataUrl] : []);
    photoViewer.renderPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Task draft photo');
  }

  function bindEvents() {
    els.taskPhoto.addEventListener('change', handlePhotoChange);
    els.taskForm.addEventListener('submit', handleSubmit);
    els.saveTaskDraftButton.addEventListener('click', persistDraft);
    els.applyTaskTemplateButton.addEventListener('click', applySelectedTaskTemplate);
    els.saveTaskTemplateButton.addEventListener('click', saveCurrentTaskTemplate);
    els.deleteTaskTemplateButton.addEventListener('click', deleteSelectedTaskTemplate);
  }

  return {
    bindEvents,
    refreshTaskTemplates,
    restoreDraft
  };
}
