import {
  decideRecord as decideBackendRecord,
  exportSupervisorRecordsCsv,
  exportSupervisorTaskLogsCsv,
  getSupervisorReviewRecords as getBackendSupervisorReviewRecords,
  updateSupervisorRecord as updateBackendSupervisorRecord,
  updateSupervisorTaskLog as updateBackendSupervisorTaskLog
} from './api-client.js';
import {
  decideRecord as decideLocalRecord,
  getPendingApprovals,
  getReviewedApprovals,
  getTaskLogRecords
} from './mock-api.js';
import { todayDateInput, escapeHtml } from './utils.js';

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
    if (record.type === 'form') counts.form += 1;
    return counts;
  }, {
    pending: 0,
    reviewed: 0,
    attendance: 0,
    task: 0,
    form: 0
  });
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
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber,
  siteSelectOptions
}) {
  function getFilters() {
    return {
      query: els.supervisorSearchInput.value,
      type: els.supervisorTypeFilter.value,
      status: els.supervisorStatusFilter.value,
      date: els.supervisorDateFilter.value
    };
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

    const counts = reviewRecordCounts(reviewRecords);

    els.supervisorSummary.innerHTML = `
      <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
      <div class="summary-item"><span>Needs review</span><strong>${counts.pending}</strong></div>
      <div class="summary-item"><span>Reviewed</span><strong>${counts.reviewed}</strong></div>
      <div class="summary-item"><span>Check in/out</span><strong>${counts.attendance}</strong></div>
      <div class="summary-item"><span>Task logs</span><strong>${counts.task}</strong></div>
      <div class="summary-item"><span>Forms</span><strong>${counts.form}</strong></div>
      <div class="summary-item"><span>Source</span><strong>${usingBackend ? 'Backend' : 'This device'}</strong></div>
    `;
    state.supervisorRecords = { reviewRecords };
    renderFilteredLists();
    renderSupervisorSites();
    await refreshWorkForms();
    await renderStaffUsers();
  }

  function renderFilteredLists() {
    const { reviewRecords } = state.supervisorRecords;
    const filteredRecords = historyModule.filterRecords(reviewRecords, getFilters());

    els.supervisorResultCount.textContent = `${filteredRecords.length}/${reviewRecords.length}`;
    historyModule.renderRecordsList(els.reviewQueueList, filteredRecords, {
      showDecisionActions: true,
      showEditActions: true
    });
  }

  function clearFilters() {
    els.supervisorSearchInput.value = '';
    els.supervisorTypeFilter.value = '';
    els.supervisorStatusFilter.value = '';
    els.supervisorDateFilter.value = '';
    renderFilteredLists();
  }

  async function handleExportAttendance() {
    try {
      const blob = await exportSupervisorRecordsCsv();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `leader-attendance-${todayDateInput()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      renderStatusBanner('Attendance CSV exported.');
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export attendance CSV.', true);
    }
  }

  async function handleExportTaskLogs() {
    try {
      const blob = await exportSupervisorTaskLogsCsv();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `leader-task-logs-${todayDateInput()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      renderStatusBanner('Task logs CSV exported.');
    } catch (error) {
      renderStatusBanner(error.message || 'Could not export task logs CSV.', true);
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
      renderStatusBanner('Form submissions can be approved or rejected, but not adjusted here yet.', true);
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
    els.exportAttendanceButton.addEventListener('click', handleExportAttendance);
    els.exportTaskLogsButton.addEventListener('click', handleExportTaskLogs);
  }

  return {
    bindEvents,
    handleDecision,
    handleEditRecord,
    renderFilteredLists,
    renderPanel
  };
}
