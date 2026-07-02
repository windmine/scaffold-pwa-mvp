import {
  createSupervisorAttendance as createBackendSupervisorAttendance,
  createSupervisorFormSubmission as createBackendSupervisorFormSubmission,
  createSupervisorTaskLog as createBackendSupervisorTaskLog,
  decideRecord as decideBackendRecord,
  exportSupervisorFormSubmissionCsv,
  exportSupervisorFormSubmissionHtml,
  exportSupervisorFormSubmissionPdf,
  exportSupervisorFormSubmissionsCsv,
  exportSupervisorFormSubmissionsHtml,
  exportSupervisorFormSubmissionsPdf,
  exportSupervisorRecordsCsv,
  exportSupervisorTaskLogCsv,
  exportSupervisorTaskLogHtml,
  exportSupervisorTaskLogsHtml,
  exportSupervisorTaskLogsCsv,
  getSupervisorAuditEvents as getBackendSupervisorAuditEvents,
  getSupervisorTrash as getBackendSupervisorTrash,
  getSupervisorReviewRecords as getBackendSupervisorReviewRecords,
  moveSupervisorRecordToTrash as moveBackendSupervisorRecordToTrash,
  restoreSupervisorRecord as restoreBackendSupervisorRecord,
  updateDefaultDepartment as updateBackendDefaultDepartment,
  updateSupervisorFormSubmission as updateBackendSupervisorFormSubmission,
  updateSupervisorRecord as updateBackendSupervisorRecord,
  updateSupervisorTeamWorkLog as updateBackendSupervisorTeamWorkLog,
  updateSupervisorTaskLog as updateBackendSupervisorTaskLog,
  uploadPhoto as uploadBackendPhoto
} from './api-client.js';
import { setDateInputValue } from './date-inputs.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import {
  decideRecord as decideLocalRecord,
  getPendingApprovals,
  getReviewedApprovals,
  getTaskLogRecords
} from './mock-api.js';
import { todayDateInput, escapeHtml, formatDateTime, dataUrlToBlob } from './utils.js';

const ADMIN_TASK_LOG_FORM_PREFIX = 'adminTaskLogFormField';
const EDIT_FORM_FIELD_PREFIX = 'editFormSubmissionField';
const TEAM_BREAK_MINUTE_OPTIONS = [0, 15, 30, 45, 60];

function mergeReviewRecords(...recordGroups) {
  const recordsByKey = new Map();

  recordGroups.flat().filter(Boolean).forEach((record) => {
    const key = `${record.type || 'record'}:${record.backendRecordId || record.id}`;
    recordsByKey.set(key, record);
  });

  return Array.from(recordsByKey.values())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function reviewRecordCounts(records) {
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

function formatAuditAction(action) {
  return (action || 'change').replaceAll('_', ' ');
}

function isDayworkRecord(record) {
  const text = `${record.formName || ''}`.toLowerCase();
  return text.includes('daywork') || text.includes('daily work');
}

function isDayworkForm(form) {
  const text = `${form?.name || ''}`.toLowerCase();
  return text.includes('daywork') || text.includes('daily work');
}

function exportUsesFormType(exportType) {
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

async function uploadAdminFormSignatureAnswers(form, answers, user) {
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

function mergeExistingSignatureAnswers(form, nextAnswers, existingAnswers = {}) {
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

function teamBreakOptions(selected = 0) {
  const selectedValue = normaliseTeamBreakMinutes(selected);
  return TEAM_BREAK_MINUTE_OPTIONS
    .map((minutes) => (
      `<option value="${minutes}"${minutes === selectedValue ? ' selected' : ''}>${teamBreakLabel(minutes)}</option>`
    ))
    .join('');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function localDateTimeInputValue(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const localTime = new Date(date.getTime() - (date.getTimezoneOffset() * 60 * 1000));
  return localTime.toISOString().slice(0, 16);
}

export function createSupervisorReviewModule({
  els,
  state,
  historyModule,
  handleSessionExpired,
  renderStatusBanner,
  refreshWorkForms,
  renderSupervisorSites,
  renderStaffUsers,
  renderLocationMap,
  renderManagementAnalytics,
  renderDepartmentScopedAdminLists,
  onDefaultDepartmentChanged,
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber,
  siteSelectOptions
}) {
  function getFilters() {
    return {
      query: els.supervisorSearchInput.value,
      department: state.departmentFocusId,
      fallbackDepartment: state.user?.departmentId,
      type: els.supervisorTypeFilter.value,
      status: els.supervisorStatusFilter.value,
      date: els.supervisorDateFilter.value
    };
  }

  function departmentFocusedRecords(records) {
    if (!state.departmentFocusId) return records;
    return records.filter((record) => (
      String(record.departmentId ?? state.user?.departmentId) === String(state.departmentFocusId)
    ));
  }

  function focusedDepartmentName() {
    if (!state.departmentFocusId) return 'All departments';
    return state.departments.find(
      (department) => String(department.id) === String(state.departmentFocusId)
    )?.name || 'Department';
  }

  function itemDepartmentId(item) {
    return item?.department_id ?? item?.departmentId;
  }

  function recordActionLabel(record) {
    if (record.type === 'attendance') {
      return record.action === 'check_out' ? 'Check out' : 'Check in';
    }
    if (record.type === 'form') return 'Form submission';
    if (record.type === 'team_log') return 'Weekly team log';
    return 'Task log';
  }

  function recordTitleLabel(record) {
    if (record.type === 'form') return `${record.formName || 'Work form'} - ${record.siteName || 'No site'}`;
    if (record.type === 'team_log') return `Weekly team log - ${record.weekStart || record.workDate || 'No week'}`;
    if (record.type === 'task') return `Task log - ${record.siteName || 'No site'}`;
    return `${recordActionLabel(record)} - ${record.siteName || 'No site'}`;
  }

  function itemsForRecordDepartment(items, record) {
    return (items || []).filter((item) => (
      String(itemDepartmentId(item) ?? record.departmentId ?? state.user?.departmentId)
        === String(record.departmentId ?? state.user?.departmentId)
    ));
  }

  function selectOptionsHtml(options, selectedValue) {
    return options.map((option) => (
      `<option value="${escapeHtml(option.value)}"${String(option.value) === String(selectedValue ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
    )).join('');
  }

  function teamLogWorkerOptions(record, selectedId, selectedName = '') {
    const workers = itemsForRecordDepartment(state.staffUsers, record)
      .filter((user) => user.role === 'worker');
    const options = workers.map((user) => ({
      value: user.id,
      label: `${user.name}${user.status === 'resigned' ? ' - resigned' : ''}`
    }));
    if (selectedId && !options.some((option) => String(option.value) === String(selectedId))) {
      options.unshift({ value: selectedId, label: selectedName || `Worker ${selectedId}` });
    }
    return options;
  }

  function teamLogSiteOptions(record, selectedId, selectedName = '') {
    const sites = itemsForRecordDepartment(state.sites, record);
    const options = sites.map((site) => ({
      value: site.id,
      label: `${site.name} (#${site.id})`
    }));
    if (selectedId && !options.some((option) => String(option.value) === String(selectedId))) {
      options.unshift({ value: selectedId, label: selectedName || `Site ${selectedId}` });
    }
    return options;
  }

  function teamEntryRowHtml(record, entry = {}) {
    return `
      <div class="team-log-edit-row" data-edit-team-row>
        <label>
          Member
          <select data-edit-team-worker>
            ${selectOptionsHtml(teamLogWorkerOptions(record, entry.worker_id, entry.worker_name), entry.worker_id)}
          </select>
        </label>
        <label>
          Site
          <select data-edit-team-site>
            ${selectOptionsHtml(teamLogSiteOptions(record, entry.site_id, entry.site_name), entry.site_id)}
          </select>
        </label>
        <label>
          Date
          <input data-edit-team-date type="date" value="${escapeHtml(entry.work_date || record.weekStart || '')}" />
        </label>
        <label>
          Start
          <input data-edit-team-start type="time" value="${escapeHtml(entry.start_time || '07:00')}" />
        </label>
        <label>
          End
          <input data-edit-team-end type="time" value="${escapeHtml(entry.end_time || '15:00')}" />
        </label>
        <label>
          Break
          <select data-edit-team-break>
            ${teamBreakOptions(entry.break_minutes ?? 0)}
          </select>
        </label>
        <label class="team-log-edit-description">
          Work completed
          <textarea data-edit-team-description rows="3">${escapeHtml(entry.work_description || '')}</textarea>
        </label>
        <button type="button" class="ghost" data-edit-team-remove>Remove</button>
      </div>
    `;
  }

  function bindTeamEntryEditor(record) {
    const rows = document.getElementById('editTeamEntries');
    const addButton = document.getElementById('editTeamAddRow');
    if (!rows || !addButton) return;

    const updateRemoveButtons = () => {
      const rowCount = rows.querySelectorAll('[data-edit-team-row]').length;
      rows.querySelectorAll('[data-edit-team-remove]').forEach((button) => {
        button.disabled = rowCount <= 1;
      });
    };

    addButton.addEventListener('click', () => {
      rows.insertAdjacentHTML('beforeend', teamEntryRowHtml(record));
      updateRemoveButtons();
    });
    rows.addEventListener('click', (event) => {
      const removeButton = event.target.closest('[data-edit-team-remove]');
      if (!removeButton) return;
      removeButton.closest('[data-edit-team-row]')?.remove();
      updateRemoveButtons();
    });
    updateRemoveButtons();
  }

  function collectTeamLogEditEntries() {
    const rows = Array.from(document.querySelectorAll('#editTeamEntries [data-edit-team-row]'));
    return rows.map((row) => ({
      worker_id: Number(row.querySelector('[data-edit-team-worker]')?.value),
      site_id: Number(row.querySelector('[data-edit-team-site]')?.value),
      work_date: row.querySelector('[data-edit-team-date]')?.value || '',
      start_time: row.querySelector('[data-edit-team-start]')?.value || '',
      end_time: row.querySelector('[data-edit-team-end]')?.value || '',
      break_minutes: Number(row.querySelector('[data-edit-team-break]')?.value || 0),
      work_description: row.querySelector('[data-edit-team-description]')?.value.trim() || ''
    }));
  }

  function manualAttendanceWorkers() {
    return (state.staffUsers || []).filter((user) => (
      user.role === 'worker'
      && (
        !state.departmentFocusId
        || String(itemDepartmentId(user)) === String(state.departmentFocusId)
      )
    ));
  }

  function renderManualAttendanceSites() {
    const worker = manualAttendanceWorkers().find(
      (item) => String(item.id) === els.manualAttendanceWorker.value
    );
    const currentSiteId = els.manualAttendanceSite.value;
    const sites = worker
      ? (state.sites || []).filter(
        (site) => String(itemDepartmentId(site)) === String(itemDepartmentId(worker))
      )
      : [];
    els.manualAttendanceSite.innerHTML = sites.length
      ? sites.map((site) => (
        `<option value="${site.id}">${escapeHtml(site.name)} (#${escapeHtml(site.id)})</option>`
      )).join('')
      : '<option value="">No sites available for this worker</option>';
    if (sites.some((site) => String(site.id) === currentSiteId)) {
      els.manualAttendanceSite.value = currentSiteId;
    }
    els.manualAttendanceSubmitButton.disabled = !worker || !sites.length;
  }

  function renderManualAttendanceForm() {
    const currentWorkerId = els.manualAttendanceWorker.value;
    const workers = manualAttendanceWorkers();
    els.manualAttendanceWorker.innerHTML = workers.length
      ? workers.map((worker) => {
        const departmentName = worker.department_name || worker.departmentName || 'No department';
        const status = worker.status === 'resigned' ? ' - resigned' : '';
        return `<option value="${worker.id}">${escapeHtml(worker.name)} (${escapeHtml(departmentName)}${escapeHtml(status)})</option>`;
      }).join('')
      : '<option value="">No workers available</option>';
    if (workers.some((worker) => String(worker.id) === currentWorkerId)) {
      els.manualAttendanceWorker.value = currentWorkerId;
    }
    if (!els.manualAttendanceTime.value) {
      els.manualAttendanceTime.value = localDateTimeInputValue();
    }
    renderManualAttendanceSites();
  }

  function adminTaskLogUsers() {
    return (state.staffUsers || []).filter((user) => (
      !state.departmentFocusId
      || String(itemDepartmentId(user)) === String(state.departmentFocusId)
    ));
  }

  function selectedAdminTaskLogUser() {
    return adminTaskLogUsers().find(
      (item) => String(item.id) === els.adminTaskLogUser.value
    );
  }

  function selectedAdminTaskLogForm() {
    return (state.workForms || []).find(
      (form) => form.status === 'active' && String(form.id) === String(els.adminTaskLogFormSelect.value)
    );
  }

  function adminTaskLogForms(user) {
    if (!user) return [];
    return (state.workForms || []).filter((form) => (
      form.status === 'active'
      && String(itemDepartmentId(form)) === String(itemDepartmentId(user))
    ));
  }

  function renderAdminTaskLogSelectedForm() {
    const form = selectedAdminTaskLogForm();
    const isWorkForm = Boolean(form);

    els.adminTaskLogForm.querySelectorAll('[data-admin-task-log-plain]').forEach((field) => {
      field.classList.toggle('hidden', isWorkForm);
      field.querySelectorAll('input, textarea, select').forEach((input) => {
        input.disabled = isWorkForm;
      });
    });

    els.adminTaskLogDescription.required = !isWorkForm;
    els.adminTaskLogFormFields.classList.toggle('hidden', !isWorkForm);
    if (form) {
      renderWorkFormFields(els.adminTaskLogFormFields, form, {
        idPrefix: ADMIN_TASK_LOG_FORM_PREFIX,
        container: els.adminTaskLogFormFields
      });
    } else {
      els.adminTaskLogFormFields.innerHTML = '';
    }
  }

  function renderAdminTaskLogFormOptions() {
    const user = selectedAdminTaskLogUser();
    const currentFormId = els.adminTaskLogFormSelect.value;
    const forms = adminTaskLogForms(user);
    els.adminTaskLogFormSelect.innerHTML = [
      '<option value="">Basic task log</option>',
      ...forms.map((form) => `<option value="${form.id}">${escapeHtml(form.name)}</option>`)
    ].join('');
    els.adminTaskLogFormSelect.value = forms.some((form) => String(form.id) === currentFormId)
      ? currentFormId
      : '';
    renderAdminTaskLogSelectedForm();
  }

  function renderAdminTaskLogSites() {
    const user = selectedAdminTaskLogUser();
    const currentSiteId = els.adminTaskLogSite.value;
    const sites = user
      ? (state.sites || []).filter(
        (site) => String(itemDepartmentId(site)) === String(itemDepartmentId(user))
      )
      : [];
    els.adminTaskLogSite.innerHTML = sites.length
      ? sites.map((site) => (
        `<option value="${site.id}">${escapeHtml(site.name)} (#${escapeHtml(site.id)})</option>`
      )).join('')
      : '<option value="">No sites available for this person</option>';
    if (sites.some((site) => String(site.id) === currentSiteId)) {
      els.adminTaskLogSite.value = currentSiteId;
    }
    els.adminTaskLogSubmitButton.disabled = !user || !sites.length;
    renderAdminTaskLogFormOptions();
  }

  function renderAdminTaskLogForm() {
    const currentUserId = els.adminTaskLogUser.value;
    const users = adminTaskLogUsers();
    els.adminTaskLogUser.innerHTML = users.length
      ? users.map((user) => {
        const departmentName = user.department_name || user.departmentName || 'No department';
        const selfLabel = String(user.id) === String(state.user?.id) ? ' - You' : '';
        const status = user.status === 'resigned' ? ' - resigned' : '';
        return `<option value="${user.id}">${escapeHtml(user.name)} (${escapeHtml(user.role)}${escapeHtml(selfLabel)} | ${escapeHtml(departmentName)}${escapeHtml(status)})</option>`;
      }).join('')
      : '<option value="">No users available</option>';
    const preferredUserId = users.some((user) => String(user.id) === currentUserId)
      ? currentUserId
      : users.some((user) => String(user.id) === String(state.user?.id))
        ? String(state.user.id)
        : '';
    if (preferredUserId) {
      els.adminTaskLogUser.value = preferredUserId;
    }
    if (!els.adminTaskLogDate.value) {
      els.adminTaskLogDate.value = todayDateInput();
    }
    renderAdminTaskLogSites();
  }

  function renderExportFormTypeOptions() {
    const currentValue = els.exportFormTypeSelect.value;
    const exportType = els.exportDocumentSelect.value;
    const field = els.exportFormTypeSelect.closest('label');
    const usesFormType = exportUsesFormType(exportType);
    field?.classList.toggle('hidden', !usesFormType);
    els.exportFormTypeSelect.disabled = !usesFormType;

    if (!usesFormType) {
      els.exportFormTypeSelect.innerHTML = '<option value="">Form type not used</option>';
      els.exportFormTypeSelect.value = '';
      return;
    }

    let forms = (state.workForms || []).filter((form) => (
      !state.departmentFocusId
      || String(itemDepartmentId(form)) === String(state.departmentFocusId)
    ));
    if (exportType === 'daywork-pdf') {
      forms = forms.filter(isDayworkForm);
    }

    const defaultLabel = exportType === 'daywork-pdf'
      ? 'All Daywork form types'
      : 'All submitted form types';

    els.exportFormTypeSelect.innerHTML = [
      `<option value="">${defaultLabel}</option>`,
      ...forms.map((form) => {
        const status = form.status === 'archived' ? ' - archived' : '';
        return `<option value="${escapeHtml(form.id)}">${escapeHtml(form.name)}${escapeHtml(status)}</option>`;
      })
    ].join('');

    els.exportFormTypeSelect.value = forms.some((form) => String(form.id) === currentValue)
      ? currentValue
      : '';
  }

  function exportDateFilters(includeFormType = false) {
    const dateFrom = els.exportDateFrom.value;
    const dateTo = els.exportDateTo.value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new Error('Choose an export start date before the end date.');
    }

    const filters = { dateFrom, dateTo };
    if (els.supervisorStatusFilter.value) {
      filters.status = els.supervisorStatusFilter.value;
    }
    if (state.departmentFocusId) {
      filters.departmentId = Number(state.departmentFocusId);
    }
    if (includeFormType && !els.exportFormTypeSelect.disabled && els.exportFormTypeSelect.value) {
      filters.formId = Number(els.exportFormTypeSelect.value);
    }
    return filters;
  }

  async function runExport(button, action) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Exporting...';
    try {
      await action();
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function clearExportFilters() {
    setDateInputValue(els.exportDateFrom, '');
    setDateInputValue(els.exportDateTo, '');
    els.exportFormTypeSelect.value = '';
  }

  function renderDepartmentFilter() {
    const isGlobalAdmin = Boolean(state.user?.isGlobalAdmin);
    const currentValue = state.departmentFocusId || '';
    const departments = state.departments || [];
    const options = isGlobalAdmin
      ? [
        '<option value="">All departments</option>',
        ...departments.map((department) => (
          `<option value="${department.id}">${escapeHtml(department.name)}</option>`
        ))
      ]
      : departments
        .filter((department) => String(department.id) === String(state.user?.departmentId))
        .map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`);

    els.supervisorDepartmentFilter.innerHTML = options.join('');
    const validValue = Array.from(els.supervisorDepartmentFilter.options)
      .some((option) => option.value === currentValue);
    state.departmentFocusId = validValue
      ? currentValue
      : String(state.user?.departmentId || '');
    els.supervisorDepartmentFilter.value = state.departmentFocusId;
    els.supervisorDepartmentFilter.disabled = !isGlobalAdmin;
    els.saveDefaultDepartmentButton.classList.toggle('hidden', !isGlobalAdmin);
    const savedDefaultValue = state.user?.dashboardDepartmentId
      ? String(state.user.dashboardDepartmentId)
      : '';
    els.saveDefaultDepartmentButton.disabled = (
      String(state.departmentFocusId) === savedDefaultValue
    );
    els.supervisorDepartmentHelp.textContent = isGlobalAdmin
      ? `Saved default view: ${state.user?.dashboardDepartmentName || 'All departments'}`
      : `Fixed to ${state.user?.departmentName || 'your department'}.`;
  }

  function renderFocusedDashboard(usingBackend = state.supervisorRecords.usingBackend) {
    const reviewRecords = state.supervisorRecords.reviewRecords || [];
    const focusedRecords = departmentFocusedRecords(reviewRecords);
    const counts = reviewRecordCounts(focusedRecords);

    els.supervisorSummary.innerHTML = `
      <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
      <div class="summary-item"><span>Department focus</span><strong>${escapeHtml(focusedDepartmentName())}</strong></div>
      <div class="summary-item"><span>Needs review</span><strong>${counts.pending}</strong></div>
      <div class="summary-item"><span>Reviewed</span><strong>${counts.reviewed}</strong></div>
      <div class="summary-item"><span>Check in/out</span><strong>${counts.attendance}</strong></div>
      <div class="summary-item"><span>Task logs</span><strong>${counts.task}</strong></div>
      <div class="summary-item"><span>Team weekly logs</span><strong>${counts.teamLog}</strong></div>
      <div class="summary-item"><span>Forms</span><strong>${counts.form}</strong></div>
      <div class="summary-item"><span>Source</span><strong>${usingBackend ? 'Backend' : 'This device'}</strong></div>
    `;
    renderFilteredLists();
    renderLocationMap();
    renderManagementAnalytics();
  }

  async function renderPanel() {
    let reviewRecords;
    let usingBackend = false;

    try {
      reviewRecords = (await getBackendSupervisorReviewRecords())
        .map(historyModule.fromBackendReviewRecord)
        .filter(Boolean);
      usingBackend = true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return;
      }

      const pending = await getPendingApprovals();
      const reviewed = await getReviewedApprovals();
      const taskLogs = await getTaskLogRecords();
      reviewRecords = mergeReviewRecords(pending, reviewed, taskLogs);
      renderStatusBanner('Backend approvals are unreachable. Showing records saved on this device only.', true);
    }

    state.supervisorRecords = {
      reviewRecords,
      usingBackend,
      auditEvents: [],
      trashRecords: state.supervisorRecords.trashRecords || []
    };
    renderDepartmentFilter();
    renderFocusedDashboard(usingBackend);
    renderSupervisorSites();
    await refreshWorkForms();
    renderExportFormTypeOptions();
    await renderStaffUsers();
    renderManualAttendanceForm();
    renderAdminTaskLogForm();
    await renderAuditHistory();
    await renderTrash();
  }

  function renderFilteredLists() {
    const { reviewRecords } = state.supervisorRecords;
    const focusedRecords = departmentFocusedRecords(reviewRecords);
    const filteredRecords = historyModule.filterRecords(reviewRecords, getFilters());

    els.supervisorResultCount.textContent = `${filteredRecords.length}/${focusedRecords.length}`;
    historyModule.renderRecordsList(els.reviewQueueList, filteredRecords, {
      showDecisionActions: true,
      showEditActions: true,
      showExportActions: true,
      showTrashActions: true
    });
  }

  function clearFilters() {
    els.supervisorSearchInput.value = '';
    els.supervisorTypeFilter.value = '';
    els.supervisorStatusFilter.value = '';
    setDateInputValue(els.supervisorDateFilter, '');
    renderFilteredLists();
  }

  function handleDepartmentFilterChange() {
    state.departmentFocusId = els.supervisorDepartmentFilter.value;
    renderDepartmentFilter();
    renderFocusedDashboard();
    renderDepartmentScopedAdminLists();
    renderManualAttendanceForm();
    renderAdminTaskLogForm();
    renderExportFormTypeOptions();
    renderTrashList();
  }

  function focusedTrashRecords() {
    const records = state.supervisorRecords.trashRecords || [];
    if (!state.departmentFocusId) return records;
    return records.filter((record) => (
      String(record.departmentId ?? state.user?.departmentId) === String(state.departmentFocusId)
    ));
  }

  function renderTrashList() {
    const records = focusedTrashRecords();
    els.rubbishBinCount.textContent = String(records.length);
    els.rubbishBinList.innerHTML = records.length
      ? records.map((record) => {
        const recordLabel = recordActionLabel(record);
        return `
          <article class="record-card rubbish-bin-record">
            <div class="record-header">
              <div>
                <h3 class="record-title">${escapeHtml(recordTitleLabel(record))}</h3>
                <p class="record-meta">${escapeHtml(record.userName)} | ${escapeHtml(formatDateTime(record.createdAt))}</p>
              </div>
              <span class="badge rejected">In bin</span>
            </div>
            <div class="record-extra">
              <p><strong>Type:</strong> ${escapeHtml(recordLabel)}</p>
              <p><strong>Reason:</strong> ${escapeHtml(record.deletionReason || 'No reason recorded.')}</p>
              <p><strong>Deleted:</strong> ${escapeHtml(formatDateTime(record.deletedAt))}${record.deletedBySupervisorName ? ` by ${escapeHtml(record.deletedBySupervisorName)}` : ''}</p>
              <p><strong>Automatic deletion:</strong> ${escapeHtml(formatDateTime(record.purgeAt))}</p>
            </div>
            <div class="record-actions">
              <button type="button" data-restore-record="${escapeHtml(record.type)}:${escapeHtml(record.backendRecordId)}">Restore</button>
            </div>
          </article>
        `;
      }).join('')
      : '<div class="empty-state">The rubbish bin is empty.</div>';

    els.rubbishBinList.querySelectorAll('[data-restore-record]').forEach((button) => {
      button.addEventListener('click', async () => {
        const [recordType, recordId] = button.dataset.restoreRecord.split(':');
        await handleRestoreRecord(recordType, Number(recordId));
      });
    });
  }

  async function renderTrash() {
    try {
      const records = await getBackendSupervisorTrash();
      state.supervisorRecords.trashRecords = records
        .map(historyModule.fromBackendReviewRecord)
        .filter(Boolean);
      renderTrashList();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return;
      }
      state.supervisorRecords.trashRecords = [];
      els.rubbishBinCount.textContent = '-';
      els.rubbishBinList.innerHTML = '<div class="empty-state">The rubbish bin is unavailable.</div>';
    }
  }

  async function handleRestoreRecord(recordType, recordId) {
    if (!window.confirm('Double check: restore this record to the active review history?')) return;
    try {
      await restoreBackendSupervisorRecord(recordType, recordId);
      renderStatusBanner('Record restored from the rubbish bin.');
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not restore the record.', true);
    }
  }

  async function handleTrashRecord(record) {
    if (!record.backendRecordId || !['attendance', 'task', 'form', 'team_log'].includes(record.type)) {
      renderStatusBanner('Only backend review records can be moved to the rubbish bin.', true);
      return;
    }

    showEditPanel(
      `Move ${recordActionLabel(record).toLowerCase()} to rubbish bin`,
      [{
        id: 'trashRecordReason',
        label: 'Reason for deletion',
        type: 'textarea',
        rows: 4,
        value: ''
      }],
      'Move to rubbish bin',
      async () => {
        const reason = editValue('trashRecordReason').trim();
        if (reason.length < 3) {
          renderStatusBanner('Enter a reason for moving this record to the rubbish bin.', true);
          return;
        }
        if (!window.confirm('Double check: hide this record and keep it in the rubbish bin for 30 days?')) return;
        try {
          await moveBackendSupervisorRecordToTrash(
            record.type,
            record.backendRecordId,
            reason
          );
          closeEditPanel();
          renderStatusBanner('Record moved to the rubbish bin for 30 days.');
          await renderPanel();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not move the record to the rubbish bin.', true);
        }
      }
    );
  }

  async function handleManualAttendanceSubmit(event) {
    event.preventDefault();
    const worker = manualAttendanceWorkers().find(
      (item) => String(item.id) === els.manualAttendanceWorker.value
    );
    const occurredAt = new Date(els.manualAttendanceTime.value);
    if (!worker || !els.manualAttendanceSite.value || Number.isNaN(occurredAt.getTime())) {
      renderStatusBanner('Choose a worker, site, and valid attendance time.', true);
      return;
    }
    if (!window.confirm(
      `Double check: add this ${els.manualAttendanceType.value === 'check_out' ? 'check out' : 'check in'} for ${worker.name}?`
    )) return;

    els.manualAttendanceSubmitButton.disabled = true;
    try {
      await createBackendSupervisorAttendance({
        worker_id: Number(worker.id),
        site_id: Number(els.manualAttendanceSite.value),
        record_type: els.manualAttendanceType.value,
        occurred_at: occurredAt.toISOString(),
        note: els.manualAttendanceNote.value.trim()
      });
      els.manualAttendanceNote.value = '';
      els.manualAttendanceTime.value = localDateTimeInputValue();
      renderStatusBanner(`Manual attendance added for ${worker.name}.`);
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not add manual attendance.', true);
      renderManualAttendanceSites();
    }
  }

  async function handleAdminTaskLogSubmit(event) {
    event.preventDefault();
    const user = selectedAdminTaskLogUser();
    const form = selectedAdminTaskLogForm();
    const description = els.adminTaskLogDescription.value.trim();
    if (!user || !els.adminTaskLogSite.value || !els.adminTaskLogDate.value) {
      renderStatusBanner('Choose a person, site, and work date.', true);
      return;
    }
    if (!form && !description) {
      renderStatusBanner('Enter the task summary.', true);
      return;
    }
    if (!window.confirm(
      `Double check: submit this approved ${form ? form.name : 'log'} for ${user.name}?`
    )) return;

    els.adminTaskLogSubmitButton.disabled = true;
    try {
      if (form) {
        const answers = collectWorkFormAnswers(form, {
          idPrefix: ADMIN_TASK_LOG_FORM_PREFIX,
          container: els.adminTaskLogFormFields
        });
        await createBackendSupervisorFormSubmission({
          user_id: Number(user.id),
          form_id: Number(form.id),
          site_id: Number(els.adminTaskLogSite.value),
          work_date: els.adminTaskLogDate.value,
          answers: await uploadAdminFormSignatureAnswers(form, answers, user)
        });
      } else {
        await createBackendSupervisorTaskLog({
          user_id: Number(user.id),
          site_id: Number(els.adminTaskLogSite.value),
          work_date: els.adminTaskLogDate.value,
          hours_worked: els.adminTaskLogHours.value === ''
            ? null
            : Number(els.adminTaskLogHours.value),
          description,
          safety_notes: els.adminTaskLogSafety.value.trim() || null
        });
      }
      els.adminTaskLogHours.value = '';
      els.adminTaskLogDescription.value = '';
      els.adminTaskLogSafety.value = '';
      renderAdminTaskLogSelectedForm();
      renderStatusBanner(`Approved ${form ? form.name : 'log'} submitted for ${user.name}.`);
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not submit the approved log.', true);
      if (form) {
        els.adminTaskLogSubmitButton.disabled = false;
      } else {
        renderAdminTaskLogSites();
      }
    }
  }

  async function handleSaveDefaultDepartment() {
    if (!state.user?.isGlobalAdmin) return;

    try {
      const user = await updateBackendDefaultDepartment(
        state.departmentFocusId ? Number(state.departmentFocusId) : null
      );
      onDefaultDepartmentChanged(user);
      renderDepartmentFilter();
      renderStatusBanner(
        `Default dashboard view set to ${user.dashboardDepartmentName || 'All departments'}.`
      );
    } catch (error) {
      renderStatusBanner(error.message || 'Could not save the default department.', true);
    }
  }

  async function handleExportAttendance() {
    try {
      await runExport(els.exportAttendanceButton, async () => {
        const blob = await exportSupervisorRecordsCsv(exportDateFilters());
        downloadBlob(blob, `leader-attendance-${todayDateInput()}.csv`);
        renderStatusBanner('Attendance CSV exported.');
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export attendance CSV.', true);
    }
  }

  async function handleExportTaskLogs() {
    try {
      await runExport(els.exportTaskLogsButton, async () => {
        const blob = await exportSupervisorTaskLogsCsv(exportDateFilters());
        downloadBlob(blob, `leader-task-logs-${todayDateInput()}.csv`);
        renderStatusBanner('Task logs CSV exported.');
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export task logs CSV.', true);
    }
  }

  async function handleExportDocument() {
    const exportType = els.exportDocumentSelect.value;

    try {
      await runExport(els.exportDocumentButton, async () => {
        if (exportType === 'task-photo-report') {
          const blob = await exportSupervisorTaskLogsHtml('photo-report', exportDateFilters());
          downloadBlob(blob, `leader-task-photo-report-${todayDateInput()}.html`);
          renderStatusBanner('Task photo report exported.');
          return;
        }

        if (exportType === 'form-submissions') {
          const blob = await exportSupervisorFormSubmissionsHtml(exportDateFilters(true));
          downloadBlob(blob, `leader-work-forms-${todayDateInput()}.html`);
          renderStatusBanner('Work form submissions exported.');
          return;
        }

        if (exportType === 'form-submissions-csv') {
          const blob = await exportSupervisorFormSubmissionsCsv(exportDateFilters(true));
          downloadBlob(blob, `leader-work-forms-${todayDateInput()}.csv`);
          renderStatusBanner('Work form submissions CSV exported.');
          return;
        }

        if (exportType === 'form-submissions-pdf') {
          const blob = await exportSupervisorFormSubmissionsPdf('submitted-form', exportDateFilters(true));
          downloadBlob(blob, `leader-work-forms-${todayDateInput()}.pdf`);
          renderStatusBanner('Work form submissions PDF exported.');
          return;
        }

        if (exportType === 'daywork-pdf') {
          const blob = await exportSupervisorFormSubmissionsPdf('daywork', exportDateFilters(true));
          downloadBlob(blob, `leader-daywork-${todayDateInput()}.pdf`);
          renderStatusBanner('Daywork PDF exported.');
          return;
        }

        const blob = await exportSupervisorTaskLogsHtml('daily-log', exportDateFilters());
        downloadBlob(blob, `leader-daily-task-logs-${todayDateInput()}.html`);
        renderStatusBanner('Daily task log sheets exported.');
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export document.', true);
    }
  }

  async function handleExportRecord(record, exportType) {
    if (!record.backendRecordId) {
      renderStatusBanner('Only backend records can be exported.', true);
      return;
    }

    try {
      if (exportType === 'task-photo-report-html') {
        const blob = await exportSupervisorTaskLogHtml(record.backendRecordId, 'photo-report');
        downloadBlob(blob, `leader-task-log-${record.backendRecordId}-photo-report-${todayDateInput()}.html`);
        renderStatusBanner('Task photo report exported.');
        return;
      }

      if (exportType === 'task-csv') {
        const blob = await exportSupervisorTaskLogCsv(record.backendRecordId);
        downloadBlob(blob, `leader-task-log-${record.backendRecordId}-${todayDateInput()}.csv`);
        renderStatusBanner('Task log CSV row exported.');
        return;
      }

      if (exportType === 'form-html') {
        const blob = await exportSupervisorFormSubmissionHtml(record.backendRecordId);
        downloadBlob(blob, `leader-form-${record.backendRecordId}-${todayDateInput()}.html`);
        renderStatusBanner('Form submission exported.');
        return;
      }

      if (exportType === 'form-pdf') {
        const blob = await exportSupervisorFormSubmissionPdf(record.backendRecordId, 'submitted-form');
        downloadBlob(blob, `leader-form-${record.backendRecordId}-${todayDateInput()}.pdf`);
        renderStatusBanner('Form submission PDF exported.');
        return;
      }

      if (exportType === 'daywork-pdf') {
        if (!isDayworkRecord(record)) {
          renderStatusBanner('This submission is not a Daywork form.', true);
          return;
        }
        const blob = await exportSupervisorFormSubmissionPdf(record.backendRecordId, 'daywork');
        downloadBlob(blob, `leader-daywork-${record.backendRecordId}-${todayDateInput()}.pdf`);
        renderStatusBanner('Daywork PDF exported.');
        return;
      }

      if (exportType === 'form-csv') {
        const blob = await exportSupervisorFormSubmissionCsv(record.backendRecordId);
        downloadBlob(blob, `leader-form-${record.backendRecordId}-${todayDateInput()}.csv`);
        renderStatusBanner('Form submission CSV row exported.');
        return;
      }

      const blob = await exportSupervisorTaskLogHtml(record.backendRecordId, 'daily-log');
      downloadBlob(blob, `leader-task-log-${record.backendRecordId}-daily-log-${todayDateInput()}.html`);
      renderStatusBanner('Daily task log exported.');
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export record.', true);
    }
  }

  function renderAuditEventsList(events) {
    els.auditEventsList.innerHTML = '';
    els.auditEventsCount.textContent = String(events.length);

    if (!events.length) {
      els.auditEventsList.innerHTML = '<div class="empty-state">No supervisor changes have been recorded yet.</div>';
      return;
    }

    events.forEach((event) => {
      const node = document.createElement('article');
      node.className = 'record-card audit-event-card';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(event.summary || formatAuditAction(event.action))}</h3>
            <div class="audit-editor-grid">
              <span><small>Editor</small><strong>${escapeHtml(event.actor_name || event.actor_email || 'Unknown user')}</strong></span>
              <span><small>Group</small><strong>${escapeHtml(event.actor_department_name || event.department_name || 'No group')}</strong></span>
              <span><small>Access</small><strong>${escapeHtml(event.actor_access_level || 'Unknown')}</strong></span>
              <span><small>Edited</small><strong>${escapeHtml(formatDateTime(event.created_at))}</strong></span>
            </div>
          </div>
          <span class="badge synced">${escapeHtml(formatAuditAction(event.action))}</span>
        </div>
        <p class="record-detail">${escapeHtml(event.entity_type || 'record')} #${escapeHtml(event.entity_id ?? '-')}</p>
      `;
      els.auditEventsList.appendChild(node);
    });
  }

  async function renderAuditHistory() {
    try {
      const events = await getBackendSupervisorAuditEvents(50);
      state.supervisorRecords.auditEvents = events;
      renderAuditEventsList(events);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return;
      }

      state.supervisorRecords.auditEvents = [];
      els.auditEventsCount.textContent = '-';
      els.auditEventsList.innerHTML = '<div class="empty-state">Audit history is unavailable.</div>';
    }
  }

  async function handleDecision(record, decision) {
    try {
      if (record.backendRecordId) {
        await decideBackendRecord(record.backendRecordId, decision, record.type || 'attendance');
      } else {
        await decideLocalRecord(record.id, decision);
      }

      renderStatusBanner(`Record ${decision}.`);
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || `Could not mark record as ${decision}.`, true);
    }
  }

  async function handleEditRecord(record) {
    if (!record.backendRecordId) {
      renderStatusBanner('Only backend records can be adjusted by a supervisor.', true);
      return;
    }

    if (record.type === 'form') {
      const form = {
        id: record.formId,
        name: record.formName,
        fields: record.fields || []
      };
      const siteOptions = [
        { value: '', label: 'No site' },
        ...itemsForRecordDepartment(state.sites, record).map((site) => ({
          value: site.id,
          label: `${site.name} (#${site.id})`
        }))
      ];

      showEditPanel(
        `Edit form submission: ${record.formName}`,
        [
          { id: 'editFormSiteId', label: 'Site', type: 'select', value: record.siteId || '', options: siteOptions },
          { id: 'editFormWorkDate', label: 'Work date', type: 'date', value: record.workDate || '' },
          {
            id: 'editFormStatus',
            label: 'Status',
            type: 'select',
            value: record.status || 'pending',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' }
            ]
          },
          { type: 'custom', html: '<div id="editFormAnswers" class="dynamic-fields"></div>' }
        ],
        'Save form',
        async () => {
          if (!window.confirm('Double check: save changes to this form submission?')) return;
          try {
            const answersContainer = document.getElementById('editFormAnswers');
            const collectedAnswers = collectWorkFormAnswers(form, {
              idPrefix: EDIT_FORM_FIELD_PREFIX,
              container: answersContainer,
              validate: false
            });
            const answers = mergeExistingSignatureAnswers(form, collectedAnswers, record.answers || {});
            await updateBackendSupervisorFormSubmission(record.backendRecordId, {
              site_id: editNumber('editFormSiteId'),
              work_date: editValue('editFormWorkDate') || null,
              answers: await uploadAdminFormSignatureAnswers(form, answers, { id: record.userId }),
              status: editValue('editFormStatus')
            });
            closeEditPanel();
            renderStatusBanner('Form submission updated.');
            await renderPanel();
          } catch (error) {
            renderStatusBanner(error.message || 'Could not update form submission.', true);
          }
        }
      );

      const answersContainer = document.getElementById('editFormAnswers');
      renderWorkFormFields(answersContainer, form, {
        idPrefix: EDIT_FORM_FIELD_PREFIX,
        container: answersContainer
      });
      populateWorkFormAnswers(form, record.answers || {}, {
        idPrefix: EDIT_FORM_FIELD_PREFIX,
        container: answersContainer
      });
      return;
    }

    if (record.type === 'team_log') {
      const entriesHtml = (record.entries?.length ? record.entries : [{}])
        .map((entry) => teamEntryRowHtml(record, entry))
        .join('');

      showEditPanel(
        `Edit weekly team log: ${record.weekStart}`,
        [
          { id: 'editTeamWeekStart', label: 'Week start', type: 'date', value: record.weekStart || record.workDate || '' },
          {
            id: 'editTeamStatus',
            label: 'Status',
            type: 'select',
            value: record.status || 'pending',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' }
            ]
          },
          { id: 'editTeamNotes', label: 'Notes', type: 'textarea', rows: 3, value: record.notes || '' },
          {
            type: 'custom',
            html: `
              <section class="team-log-edit-section">
                <div class="section-heading">
                  <div>
                    <p class="eyebrow">Team entries</p>
                    <h3>Member time rows</h3>
                  </div>
                  <button id="editTeamAddRow" type="button" class="ghost">Add row</button>
                </div>
                <div id="editTeamEntries" class="team-log-edit-rows">${entriesHtml}</div>
              </section>
            `
          }
        ],
        'Save team log',
        async () => {
          const entries = collectTeamLogEditEntries();
          if (!entries.length || entries.some((entry) => (
            !entry.worker_id
            || !entry.site_id
            || !entry.work_date
            || !entry.start_time
            || !entry.end_time
            || !entry.work_description
          ))) {
            renderStatusBanner('Complete every team log row before saving.', true);
            return;
          }
          if (!window.confirm('Double check: save changes to this weekly team log?')) return;
          try {
            await updateBackendSupervisorTeamWorkLog(record.backendRecordId, {
              week_start: editValue('editTeamWeekStart'),
              notes: editValue('editTeamNotes') || null,
              status: editValue('editTeamStatus'),
              entries
            });
            closeEditPanel();
            renderStatusBanner('Weekly team log updated.');
            await renderPanel();
          } catch (error) {
            renderStatusBanner(error.message || 'Could not update weekly team log.', true);
          }
        }
      );
      bindTeamEntryEditor(record);
      return;
    }

    if (record.type === 'task') {
      showEditPanel(
        `Edit task log: ${record.siteName}`,
        [
          { id: 'editTaskSiteId', label: 'Site', type: 'select', value: record.siteId || '', options: siteSelectOptions() },
          { id: 'editTaskWorkDate', label: 'Work date', type: 'date', value: record.workDate || '' },
          { id: 'editTaskHours', label: 'Hours worked', type: 'number', step: '0.25', min: 0, max: 24, value: record.hoursWorked || '' },
          { id: 'editTaskDescription', label: 'Task summary', type: 'textarea', rows: 4, value: record.summary || '' },
          { id: 'editTaskSafety', label: 'Safety notes', type: 'textarea', rows: 3, value: record.safetyNotes || '' },
          {
            id: 'editTaskStatus',
            label: 'Status',
            type: 'select',
            value: record.status || 'pending',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' }
            ]
          }
        ],
        'Save task log',
        async () => {
          if (!window.confirm('Double check: save changes to this task log?')) return;
          try {
            await updateBackendSupervisorTaskLog(record.backendRecordId, {
              site_id: editNumber('editTaskSiteId'),
              work_date: editValue('editTaskWorkDate') || null,
              hours_worked: editNumber('editTaskHours'),
              description: editValue('editTaskDescription'),
              safety_notes: editValue('editTaskSafety') || null,
              status: editValue('editTaskStatus')
            });
            closeEditPanel();
            renderStatusBanner('Task log updated.');
            await renderPanel();
          } catch (error) {
            renderStatusBanner(error.message || 'Could not update task log.', true);
          }
        }
      );
      return;
    }

    showEditPanel(
      `Edit attendance: ${record.siteName}`,
      [
        {
          id: 'editAttendanceType',
          label: 'Type',
          type: 'select',
          value: record.action || 'check_in',
          options: [
            { value: 'check_in', label: 'Check in' },
            { value: 'check_out', label: 'Check out' }
          ]
        },
        { id: 'editAttendanceSiteId', label: 'Site', type: 'select', value: record.siteId || '', options: siteSelectOptions() },
        { id: 'editAttendanceLatitude', label: 'Latitude', type: 'number', step: '0.000001', min: -90, max: 90, value: record.location?.latitude || '' },
        { id: 'editAttendanceLongitude', label: 'Longitude', type: 'number', step: '0.000001', min: -180, max: 180, value: record.location?.longitude || '' },
        { id: 'editAttendanceAccuracy', label: 'Accuracy metres', type: 'number', min: 0, value: record.location?.accuracy || '' },
        {
          id: 'editAttendanceStatus',
          label: 'Status',
          type: 'select',
          value: record.status || 'pending',
          options: [
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' }
          ]
        },
        { id: 'editAttendanceNote', label: 'Notes', type: 'textarea', rows: 4, value: record.notes || '' }
      ],
      'Save attendance',
      async () => {
        if (!window.confirm('Double check: save changes to this check-in/check-out record?')) return;
        try {
          await updateBackendSupervisorRecord(record.backendRecordId, {
            record_type: editValue('editAttendanceType'),
            site_id: editNumber('editAttendanceSiteId'),
            latitude: editNumber('editAttendanceLatitude'),
            longitude: editNumber('editAttendanceLongitude'),
            accuracy: editNumber('editAttendanceAccuracy'),
            note: editValue('editAttendanceNote') || null,
            status: editValue('editAttendanceStatus')
          });
          closeEditPanel();
          renderStatusBanner('Attendance record updated.');
          await renderPanel();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update attendance record.', true);
        }
      }
    );
  }

  function bindEvents() {
    els.refreshSupervisorButton.addEventListener('click', renderPanel);
    els.supervisorDepartmentFilter.addEventListener('change', handleDepartmentFilterChange);
    els.saveDefaultDepartmentButton.addEventListener('click', handleSaveDefaultDepartment);
    [
      els.supervisorSearchInput,
      els.supervisorTypeFilter,
      els.supervisorStatusFilter,
      els.supervisorDateFilter
    ].forEach((element) => {
      element.addEventListener('input', renderFilteredLists);
      element.addEventListener('change', renderFilteredLists);
    });
    els.clearSupervisorFiltersButton.addEventListener('click', clearFilters);
    els.clearExportFiltersButton.addEventListener('click', clearExportFilters);
    els.exportDocumentSelect.addEventListener('change', renderExportFormTypeOptions);
    els.exportAttendanceButton.addEventListener('click', handleExportAttendance);
    els.exportTaskLogsButton.addEventListener('click', handleExportTaskLogs);
    els.exportDocumentButton.addEventListener('click', handleExportDocument);
    els.refreshAuditButton.addEventListener('click', renderAuditHistory);
    els.refreshRubbishBinButton.addEventListener('click', renderTrash);
    els.manualAttendanceWorker.addEventListener('change', renderManualAttendanceSites);
    els.manualAttendanceForm.addEventListener('submit', handleManualAttendanceSubmit);
    els.adminTaskLogUser.addEventListener('change', renderAdminTaskLogSites);
    els.adminTaskLogFormSelect.addEventListener('change', renderAdminTaskLogSelectedForm);
    els.adminTaskLogForm.addEventListener('submit', handleAdminTaskLogSubmit);
  }

  return {
    bindEvents,
    handleDecision,
    handleEditRecord,
    handleExportRecord,
    handleTrashRecord,
    renderAuditHistory,
    renderAdminTaskLogForm,
    renderFilteredLists,
    renderPanel,
    renderTrash
  };
}
