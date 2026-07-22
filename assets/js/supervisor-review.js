import {
  createSupervisorAttendance as createBackendSupervisorAttendance,
  createSupervisorFormSubmission as createBackendSupervisorFormSubmission,
  createSupervisorTaskLog as createBackendSupervisorTaskLog,
  decideRecord as decideBackendRecord,
  getSupervisorAuditEvents as getBackendSupervisorAuditEvents,
  getSupervisorTrash as getBackendSupervisorTrash,
  getSupervisorReviewQueuePage as getBackendSupervisorReviewQueuePage,
  moveSupervisorRecordToTrash as moveBackendSupervisorRecordToTrash,
  restoreSupervisorRecord as restoreBackendSupervisorRecord,
  updateDefaultDepartment as updateBackendDefaultDepartment,
  updateSupervisorFormSubmission as updateBackendSupervisorFormSubmission,
  updateSupervisorRecord as updateBackendSupervisorRecord,
  updateSupervisorTeamWorkLog as updateBackendSupervisorTeamWorkLog,
  updateSupervisorTaskLog as updateBackendSupervisorTaskLog
} from './api-client.js';
import { setDateInputValue } from './date-inputs.js';
import { createReviewExportAdapters } from './review-export-adapters.js';
import { collectWorkFormAnswers, populateWorkFormAnswers, renderWorkFormFields } from './work-form-fields.js';
import { todayDateInput, escapeHtml, formatDateTime } from './utils.js';
import {
  exportUsesFormType,
  formatAuditAction,
  isDayworkForm,
  isDayworkRecord,
  localDateTimeInputValue,
  loadReviewOverview,
  mergeExistingSignatureAnswers,
  mergeReviewRecords,
  reviewOverviewCounts,
  teamBreakOptions,
  uploadAdminFormSignatureAnswers
} from './supervisor-review-utils.js';

const ADMIN_TASK_LOG_FORM_PREFIX = 'adminTaskLogFormField';
const EDIT_FORM_FIELD_PREFIX = 'editFormSubmissionField';
const REVIEW_QUEUE_PAGE_SIZE = 50;
const REVIEW_QUEUE_MODE = {
  LIVE: 'live',
  OFFLINE_READ_ONLY: 'offline_read_only'
};
const reviewExports = createReviewExportAdapters();

export function createSupervisorReviewModule({
  els,
  state,
  feedback,
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
  let filterRefreshTimer = null;
  let reviewQueueRequestId = 0;
  let reviewOverviewRequestId = 0;
  let selectedReviewRecordKey = '';
  let visibleReviewRecords = [];
  let decisionInProgress = false;

  function reviewQueueIsReadOnly() {
    return state.supervisorRecords.queueMode !== REVIEW_QUEUE_MODE.LIVE;
  }

  function requireDurableWritableRecord(record, action) {
    if (
      reviewQueueIsReadOnly()
      || record?.readOnly
      || record?.durability !== 'durable'
      || !record?.backendRecordId
    ) {
      renderStatusBanner(`Reconnect before ${action} a durable Review Record.`, true);
      return false;
    }
    return true;
  }

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

  function reviewQueueQuery() {
    const filters = getFilters();
    return {
      status: filters.status,
      kind: filters.type,
      departmentId: filters.department,
      recordDate: filters.date,
      search: filters.query.trim()
    };
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

  function reviewRecordKey(record) {
    return `${record?.type || 'record'}:${record?.backendRecordId || record?.id || ''}`;
  }

  function renderReviewDetail(record) {
    const readOnly = reviewQueueIsReadOnly();
    const selectedIndex = record
      ? visibleReviewRecords.findIndex((item) => reviewRecordKey(item) === reviewRecordKey(record))
      : -1;

    els.reviewQueueModeBadge.textContent = readOnly ? 'Read only' : 'Live';
    els.reviewQueueModeBadge.className = `badge ${readOnly ? 'rejected' : 'approved'}`;
    els.reviewQueueSelectionPosition.textContent = record
      ? `${selectedIndex + 1} of ${visibleReviewRecords.length}`
      : `0 of ${visibleReviewRecords.length}`;
    els.previousReviewRecordButton.disabled = selectedIndex <= 0;
    els.nextReviewRecordButton.disabled = selectedIndex < 0 || selectedIndex >= visibleReviewRecords.length - 1;

    if (!record) {
      els.reviewQueueDetailTitle.textContent = 'Select a record';
      els.reviewQueueDetail.innerHTML = `
        <div class="empty-state review-detail-empty">
          ${visibleReviewRecords.length
            ? 'Choose a record from the inbox to see its full details and review actions.'
            : 'No records match the current filters.'}
        </div>
      `;
      return;
    }

    els.reviewQueueDetailTitle.textContent = recordTitleLabel(record);
    historyModule.renderRecordsList(els.reviewQueueDetail, [record], {
      showDecisionActions: !readOnly,
      showEditActions: !readOnly,
      showExportActions: !readOnly,
      showTrashActions: !readOnly
    });
    const detailCard = els.reviewQueueDetail.querySelector('.record-card');
    detailCard?.classList.add('review-detail-record-card');
    const actions = detailCard?.querySelector('.record-actions');
    if (actions) actions.id = 'reviewQueueActions';
  }

  function selectReviewRecord(record, { scrollOnSmallScreen = false } = {}) {
    selectedReviewRecordKey = reviewRecordKey(record);
    els.reviewQueueList.querySelectorAll('.review-queue-item').forEach((item) => {
      const selected = item.dataset.recordKey === selectedReviewRecordKey;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    renderReviewDetail(record);

    if (scrollOnSmallScreen && window.matchMedia('(max-width: 979px)').matches) {
      els.reviewQueueDetail.closest('.review-detail-shell')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }

  function selectAdjacentReviewRecord(offset) {
    const currentIndex = visibleReviewRecords.findIndex(
      (record) => reviewRecordKey(record) === selectedReviewRecordKey
    );
    const nextRecord = visibleReviewRecords[currentIndex + offset];
    if (!nextRecord) return;
    selectReviewRecord(nextRecord);
    const selectedItem = [...els.reviewQueueList.querySelectorAll('.review-queue-item')]
      .find((item) => item.dataset.recordKey === selectedReviewRecordKey);
    selectedItem?.scrollIntoView({ block: 'nearest' });
  }

  function itemsForRecordDepartment(items, record) {
    return (items || []).filter((item) => (
      String(itemDepartmentId(item) ?? record.departmentId ?? state.user?.departmentId)
        === String(record.departmentId ?? state.user?.departmentId)
    ));
  }

  function formFieldOptions(record, container, idPrefix) {
    const isDaywork = isDayworkRecord(record);
    return {
      idPrefix,
      container,
      enhanceDayworkTeamMembers: isDaywork,
      teamMembers: isDaywork
        ? itemsForRecordDepartment(state.staffUsers, record)
          .filter((user) => user.role === 'worker' && (user.status || 'active') === 'active')
          .map((user) => ({
            id: user.id,
            name: user.name,
            worker_class: user.worker_class || user.workerClass || 'normal',
            department_id: user.department_id || user.departmentId
          }))
        : []
    };
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

  function renderFocusedDashboard(queueMode = state.supervisorRecords.queueMode) {
    const reviewRecords = state.supervisorRecords.reviewRecords || [];
    const focusedRecords = departmentFocusedRecords(reviewRecords);
    const counts = reviewOverviewCounts(state.supervisorRecords, focusedRecords);
    const sourceLabel = queueMode === REVIEW_QUEUE_MODE.LIVE
      ? 'Backend (durable)'
      : reviewRecords.length
        ? 'Last durable results (read only)'
        : 'Unavailable (read only)';

    els.supervisorSummary.innerHTML = `
      <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
      <div class="summary-item"><span>Department focus</span><strong>${escapeHtml(focusedDepartmentName())}</strong></div>
      <div class="summary-item"><span>Needs review</span><strong>${counts.pending}</strong></div>
      <div class="summary-item"><span>Reviewed</span><strong>${counts.reviewed}</strong></div>
      <div class="summary-item"><span>Check in/out</span><strong>${counts.attendance}</strong></div>
      <div class="summary-item"><span>Task logs</span><strong>${counts.task}</strong></div>
      <div class="summary-item"><span>Team weekly logs</span><strong>${counts.teamLog}</strong></div>
      <div class="summary-item"><span>Forms</span><strong>${counts.form}</strong></div>
      <div class="summary-item"><span>Source</span><strong>${sourceLabel}</strong></div>
    `;
    renderFilteredLists();
    renderLocationMap();
    renderManagementAnalytics();
  }

  function recordsFromPage(page) {
    return page.items
      .map(historyModule.fromBackendReviewRecord)
      .filter(Boolean);
  }

  function normaliseBackendCounts(counts) {
    if (!counts) return null;
    return {
      ...counts,
      teamLog: counts.team_log ?? counts.teamLog ?? 0
    };
  }

  function setOfflineReadOnlyQueue(error) {
    const previous = state.supervisorRecords || {};
    const durableRecords = (previous.reviewRecords || [])
      .filter((record) => record.backendRecordId && record.durability !== 'local_only')
      .map((record) => ({ ...record, durability: 'durable', readOnly: true }));
    state.supervisorRecords = {
      ...previous,
      reviewRecords: durableRecords,
      usingBackend: false,
      queueMode: REVIEW_QUEUE_MODE.OFFLINE_READ_ONLY,
      nextCursor: null,
      hasMore: false,
      loadingMore: false,
      queueError: error?.message || 'Backend Review Queue is unreachable.'
    };
  }

  async function refreshReviewQueue() {
    const query = reviewQueueQuery();
    const requestId = ++reviewQueueRequestId;
    try {
      const page = await getBackendSupervisorReviewQueuePage({
        ...query,
        pageSize: REVIEW_QUEUE_PAGE_SIZE
      });
      if (requestId !== reviewQueueRequestId) return true;
      state.supervisorRecords = {
        ...state.supervisorRecords,
        reviewRecords: recordsFromPage(page),
        usingBackend: true,
        queueMode: REVIEW_QUEUE_MODE.LIVE,
        queueQuery: query,
        queueCounts: normaliseBackendCounts(page.counts),
        queueSummaryCounts: normaliseBackendCounts(page.summary_counts || page.counts),
        snapshotAt: page.snapshot_at || '',
        loadedAt: new Date().toISOString(),
        nextCursor: page.next_cursor || null,
        hasMore: Boolean(page.has_more && page.next_cursor),
        loadingMore: false,
        queueError: ''
      };
    } catch (error) {
      if (requestId !== reviewQueueRequestId) return true;
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return false;
      }
      setOfflineReadOnlyQueue(error);
      renderStatusBanner('Backend Review Queue is unreachable. Only the last durable results are available read-only.', true);
    }
    renderFocusedDashboard();
    return true;
  }

  async function refreshReviewOverview() {
    const departmentId = state.departmentFocusId || '';
    const requestId = ++reviewOverviewRequestId;
    const previousDepartmentId = state.supervisorRecords.analyticsDepartmentId || '';
    if (String(previousDepartmentId) !== String(departmentId)) {
      state.supervisorRecords = {
        ...state.supervisorRecords,
        analyticsRecords: [],
        analyticsReady: false,
        analyticsDepartmentId: String(departmentId),
        analyticsSnapshotAt: ''
      };
    }

    try {
      const overview = await loadReviewOverview({
        loadPage: getBackendSupervisorReviewQueuePage,
        mapRecord: historyModule.fromBackendReviewRecord,
        departmentId: departmentId || undefined
      });
      if (requestId !== reviewOverviewRequestId) return true;
      state.supervisorRecords = {
        ...state.supervisorRecords,
        analyticsRecords: overview.records,
        analyticsReady: true,
        analyticsDepartmentId: String(departmentId),
        analyticsSnapshotAt: overview.snapshotAt,
        analyticsError: '',
        queueSummaryCounts: normaliseBackendCounts(overview.counts)
          || state.supervisorRecords.queueSummaryCounts
      };
    } catch (error) {
      if (requestId !== reviewOverviewRequestId) return true;
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return false;
      }
      state.supervisorRecords = {
        ...state.supervisorRecords,
        analyticsError: error?.message || 'Complete Management Analytics data is unavailable.'
      };
      renderStatusBanner(
        'Complete Management Analytics data is unavailable. Review Queue results remain usable.',
        true
      );
    }
    renderFocusedDashboard();
    return true;
  }

  async function renderPanel() {
    renderDepartmentFilter();
    if (!await refreshReviewQueue()) return;
    if (!await refreshReviewOverview()) return;
    state.supervisorRecords = {
      ...state.supervisorRecords,
      auditEvents: [],
      trashRecords: state.supervisorRecords.trashRecords || []
    };
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

    const readOnly = reviewQueueIsReadOnly();
    const matchingTotal = state.supervisorRecords.queueCounts?.total ?? focusedRecords.length;
    els.supervisorResultCount.textContent = `${filteredRecords.length}/${matchingTotal} matching records loaded`;
    visibleReviewRecords = filteredRecords;
    const selectedRecord = filteredRecords.find(
      (record) => reviewRecordKey(record) === selectedReviewRecordKey
    ) || filteredRecords[0] || null;
    selectedReviewRecordKey = selectedRecord ? reviewRecordKey(selectedRecord) : '';
    els.reviewQueueNotice.innerHTML = '';
    els.reviewQueuePagination.innerHTML = '';
    historyModule.renderRecordsList(els.reviewQueueList, filteredRecords, {
      summaryOnly: true,
      getRecordKey: reviewRecordKey,
      selectedRecordKey: selectedReviewRecordKey,
      onRecordSelect: (record) => selectReviewRecord(record, { scrollOnSmallScreen: true })
    });
    renderReviewDetail(selectedRecord);
    els.exportAttendanceButton.disabled = readOnly;
    els.exportTaskLogsButton.disabled = readOnly;
    els.exportDocumentButton.disabled = readOnly;

    if (readOnly) {
      const notice = document.createElement('div');
      notice.className = 'empty-state review-queue-read-only';
      notice.textContent = reviewRecords.length
        ? 'Offline read-only view of the last durable results. Reconnect before approving, rejecting, editing, exporting, or deleting Review Records.'
        : 'The durable Review Queue is unavailable offline. Unsynced Worker records are not Supervisor Review Records.';
      els.reviewQueueNotice.appendChild(notice);
      return;
    }

    if (state.supervisorRecords.hasMore) {
      const loadMoreButton = document.createElement('button');
      loadMoreButton.type = 'button';
      loadMoreButton.className = 'ghost review-queue-load-more';
      loadMoreButton.textContent = state.supervisorRecords.loadingMore ? 'Loading…' : 'Load more Review Records';
      loadMoreButton.disabled = state.supervisorRecords.loadingMore;
      loadMoreButton.addEventListener('click', loadMoreReviewRecords);
      els.reviewQueuePagination.appendChild(loadMoreButton);
    }
  }

  async function loadMoreReviewRecords() {
    const recordsState = state.supervisorRecords;
    if (
      recordsState.queueMode !== REVIEW_QUEUE_MODE.LIVE
      || recordsState.loadingMore
      || !recordsState.nextCursor
    ) return;

    const requestedCursor = recordsState.nextCursor;
    const requestedQuery = JSON.stringify(recordsState.queueQuery || {});
    recordsState.loadingMore = true;
    renderFilteredLists();
    try {
      const page = await getBackendSupervisorReviewQueuePage({
        ...(recordsState.queueQuery || {}),
        cursor: recordsState.nextCursor,
        pageSize: REVIEW_QUEUE_PAGE_SIZE
      });
      if (
        state.supervisorRecords.queueMode !== REVIEW_QUEUE_MODE.LIVE
        || state.supervisorRecords.nextCursor !== requestedCursor
        || JSON.stringify(state.supervisorRecords.queueQuery || {}) !== requestedQuery
      ) return;
      const additionalRecords = recordsFromPage(page);
      recordsState.reviewRecords = mergeReviewRecords(recordsState.reviewRecords, additionalRecords);
      recordsState.nextCursor = page.next_cursor || null;
      recordsState.hasMore = Boolean(page.has_more && recordsState.nextCursor);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return;
      }
      setOfflineReadOnlyQueue(error);
      renderStatusBanner('The Review Queue went offline. Loaded durable results are now read-only.', true);
    } finally {
      state.supervisorRecords.loadingMore = false;
      renderFocusedDashboard();
    }
  }

  async function clearFilters() {
    els.supervisorSearchInput.value = '';
    els.supervisorTypeFilter.value = '';
    els.supervisorStatusFilter.value = '';
    setDateInputValue(els.supervisorDateFilter, '');
    await refreshReviewQueue();
  }

  function scheduleReviewQueueRefresh() {
    window.clearTimeout(filterRefreshTimer);
    filterRefreshTimer = window.setTimeout(() => {
      refreshReviewQueue();
    }, 250);
  }

  async function handleDepartmentFilterChange() {
    state.departmentFocusId = els.supervisorDepartmentFilter.value;
    renderDepartmentFilter();
    if (!await refreshReviewQueue()) return;
    if (!await refreshReviewOverview()) return;
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
    if (!requireDurableWritableRecord(record, 'moving')) return;
    if (!['attendance', 'task', 'form', 'team_log'].includes(record.type)) {
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
      const field = !worker
        ? els.manualAttendanceWorker
        : !els.manualAttendanceSite.value
          ? els.manualAttendanceSite
          : els.manualAttendanceTime;
      renderStatusBanner('Choose a worker, site, and valid attendance time.', true, {
        local: els.manualAttendanceFeedback,
        field,
        tone: 'error'
      });
      return;
    }
    if (!window.confirm(
      `Double check: add this ${els.manualAttendanceType.value === 'check_out' ? 'check out' : 'check in'} for ${worker.name}?`
    )) return;

    feedback.clearLocal(els.manualAttendanceFeedback);
    feedback.setButtonBusy(els.manualAttendanceSubmitButton, true, 'Adding attendance...');
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
      renderStatusBanner(`Manual attendance added for ${worker.name}.`, false, {
        local: els.manualAttendanceFeedback,
        tone: 'success'
      });
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not add manual attendance.', true, {
        local: els.manualAttendanceFeedback,
        tone: 'error'
      });
      renderManualAttendanceSites();
    } finally {
      feedback.setButtonBusy(els.manualAttendanceSubmitButton, false);
    }
  }

  async function handleAdminTaskLogSubmit(event) {
    event.preventDefault();
    const user = selectedAdminTaskLogUser();
    const form = selectedAdminTaskLogForm();
    const description = els.adminTaskLogDescription.value.trim();
    if (!user || !els.adminTaskLogSite.value || !els.adminTaskLogDate.value) {
      const field = !user
        ? els.adminTaskLogUser
        : !els.adminTaskLogSite.value
          ? els.adminTaskLogSite
          : els.adminTaskLogDate;
      renderStatusBanner('Choose a person, site, and work date.', true, {
        local: els.adminTaskLogFeedback,
        field,
        tone: 'error'
      });
      return;
    }
    if (!form && !description) {
      renderStatusBanner('Enter the task summary.', true, {
        local: els.adminTaskLogFeedback,
        field: els.adminTaskLogDescription,
        tone: 'error'
      });
      return;
    }
    if (!window.confirm(
      `Double check: submit this approved ${form ? form.name : 'log'} for ${user.name}?`
    )) return;

    feedback.clearLocal(els.adminTaskLogFeedback);
    feedback.setButtonBusy(els.adminTaskLogSubmitButton, true, 'Submitting approved log...');
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
      renderStatusBanner(`Approved ${form ? form.name : 'log'} submitted for ${user.name}.`, false, {
        local: els.adminTaskLogFeedback,
        tone: 'success'
      });
      await renderPanel();
    } catch (error) {
      const invalidField = error.fieldId ? document.getElementById(error.fieldId) : null;
      renderStatusBanner(error.message || 'Could not submit the approved log.', true, {
        local: els.adminTaskLogFeedback,
        field: invalidField,
        tone: 'error'
      });
      if (form) {
        els.adminTaskLogSubmitButton.disabled = false;
      } else {
        renderAdminTaskLogSites();
      }
    } finally {
      feedback.setButtonBusy(els.adminTaskLogSubmitButton, false);
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
    if (reviewQueueIsReadOnly()) {
      renderStatusBanner('Reconnect before exporting durable Review Records.', true);
      return;
    }
    try {
      await runExport(els.exportAttendanceButton, async () => {
        const message = await reviewExports.exportCollection('attendance-csv', exportDateFilters());
        renderStatusBanner(message);
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export attendance CSV.', true);
    }
  }

  async function handleExportTaskLogs() {
    if (reviewQueueIsReadOnly()) {
      renderStatusBanner('Reconnect before exporting durable Review Records.', true);
      return;
    }
    try {
      await runExport(els.exportTaskLogsButton, async () => {
        const message = await reviewExports.exportCollection('task-logs-csv', exportDateFilters());
        renderStatusBanner(message);
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export task logs CSV.', true);
    }
  }

  async function handleExportDocument() {
    const exportType = els.exportDocumentSelect.value;
    if (reviewQueueIsReadOnly()) {
      renderStatusBanner('Reconnect before exporting durable Review Records.', true);
      return;
    }

    try {
      await runExport(els.exportDocumentButton, async () => {
        const usesFormType = ['form-submissions', 'form-submissions-csv', 'form-submissions-pdf', 'daywork-pdf']
          .includes(exportType);
        const message = await reviewExports.exportCollection(
          exportType,
          exportDateFilters(usesFormType)
        );
        renderStatusBanner(message);
      });
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export document.', true);
    }
  }

  async function handleExportRecord(record, exportType) {
    if (!requireDurableWritableRecord(record, 'exporting')) return;

    try {
      const message = await reviewExports.exportRecord(record, exportType);
      renderStatusBanner(message);
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

  async function handleDecision(record, decision, button = null) {
    if (!requireDurableWritableRecord(record, decision === 'approved' ? 'approving' : 'rejecting')) return;
    if (decisionInProgress) return;
    decisionInProgress = true;
    feedback.clearLocal(els.reviewQueueFeedback);
    const siblingButtons = button
      ? [...button.closest('.record-actions')?.querySelectorAll('button') || []]
      : [];
    const disabledStates = siblingButtons.map((item) => item.disabled);
    siblingButtons.forEach((item) => { item.disabled = true; });
    feedback.setButtonBusy(button, true, decision === 'approved' ? 'Approving...' : 'Rejecting...');
    try {
      await decideBackendRecord(record.backendRecordId, decision, record.type || 'attendance');

      renderStatusBanner(`Record ${decision}.`, false, {
        local: els.reviewQueueFeedback,
        tone: 'success'
      });
      await renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || `Could not mark record as ${decision}.`, true, {
        local: els.reviewQueueFeedback,
        tone: 'error'
      });
    } finally {
      feedback.setButtonBusy(button, false);
      siblingButtons.forEach((item, index) => {
        item.disabled = disabledStates[index];
      });
      decisionInProgress = false;
    }
  }

  async function handleEditRecord(record) {
    if (!requireDurableWritableRecord(record, 'editing')) return;

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
          { type: 'custom', html: '<div id="editFormAnswers" class="dynamic-fields"></div>' }
        ],
        'Save form',
        async () => {
          if (!window.confirm('Double check: save changes to this form submission?')) return;
          try {
            const answersContainer = document.getElementById('editFormAnswers');
            const collectedAnswers = collectWorkFormAnswers(form, {
              ...formFieldOptions(record, answersContainer, EDIT_FORM_FIELD_PREFIX),
              validate: false
            });
            const answers = mergeExistingSignatureAnswers(form, collectedAnswers, record.answers || {});
            await updateBackendSupervisorFormSubmission(record.backendRecordId, {
              site_id: editNumber('editFormSiteId'),
              work_date: editValue('editFormWorkDate') || null,
              answers: await uploadAdminFormSignatureAnswers(form, answers, { id: record.userId })
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
      const options = formFieldOptions(record, answersContainer, EDIT_FORM_FIELD_PREFIX);
      renderWorkFormFields(answersContainer, form, options);
      populateWorkFormAnswers(form, record.answers || {}, options);
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
          { id: 'editTaskSafety', label: 'Safety notes', type: 'textarea', rows: 3, value: record.safetyNotes || '' }
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
              safety_notes: editValue('editTaskSafety') || null
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
            note: editValue('editAttendanceNote') || null
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
    els.previousReviewRecordButton.addEventListener('click', () => selectAdjacentReviewRecord(-1));
    els.nextReviewRecordButton.addEventListener('click', () => selectAdjacentReviewRecord(1));
    els.supervisorDepartmentFilter.addEventListener('change', handleDepartmentFilterChange);
    els.saveDefaultDepartmentButton.addEventListener('click', handleSaveDefaultDepartment);
    [
      els.supervisorSearchInput,
      els.supervisorTypeFilter,
      els.supervisorStatusFilter,
      els.supervisorDateFilter
    ].forEach((element) => {
      element.addEventListener('input', scheduleReviewQueueRefresh);
      element.addEventListener('change', scheduleReviewQueueRefresh);
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
