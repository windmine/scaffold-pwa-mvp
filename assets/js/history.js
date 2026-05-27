import {
  getMyFormSubmissions as getBackendMyFormSubmissions,
  getMyRecords as getBackendMyAttendanceRecords,
  getMyTaskLogs as getBackendMyTaskLogs
} from './api-client.js';
import { getWorkerRecords as getLocalWorkerRecords } from './mock-api.js';
import { normaliseRecordPhotoUrls } from './offline-submissions.js';
import { dateInputValue, formatDateTime, todayDateInput, escapeHtml } from './utils.js';

function getBackendSiteId(siteId) {
  if (!siteId) return null;

  const directId = Number(siteId);
  return Number.isInteger(directId) ? directId : null;
}

function formAnswerSummary(record) {
  const answers = record.answers || {};
  const fields = record.fields || [];
  const entries = fields.length
    ? fields.map((field) => [field.label || field.id, answers[field.id], field.type])
    : Object.entries(answers).map(([label, value]) => [label, value, '']);

  return entries
    .filter(([, value]) => value !== '' && value != null && value !== false)
    .map(([label, value, type]) => `${label}: ${type === 'signature' ? 'Signed' : value === true ? 'Yes' : value}`)
    .join(' | ');
}

function signatureImageSources(record) {
  const answers = record.answers || {};
  return (record.fields || [])
    .filter((field) => field.type === 'signature' && answers[field.id])
    .map((field) => ({
      label: field.label || 'Signature',
      src: answers[field.id]
    }));
}

function getRecordDate(record) {
  return record.workDate || dateInputValue(record.createdAt);
}

function recordSearchText(record) {
  return [
    record.type,
    record.action,
    record.status,
    record.syncStatus,
    record.withinSiteRadius === true ? 'inside site radius' : '',
    record.withinSiteRadius === false ? 'outside site radius' : '',
    record.distanceFromSiteM,
    record.userName,
    record.siteName,
    record.formName,
    record.notes,
    record.summary,
    record.safetyNotes,
    record.workDate,
    record.hoursWorked,
    formAnswerSummary(record)
  ].join(' ').toLowerCase();
}

export function filterRecords(records, filters) {
  const query = filters.query.trim().toLowerCase();

  return records.filter((record) => {
    if (filters.type && record.type !== filters.type) return false;
    if (filters.date && getRecordDate(record) !== filters.date) return false;
    if (filters.status && record.status !== filters.status && record.syncStatus !== filters.status) return false;
    if (query && !recordSearchText(record).includes(query)) return false;
    return true;
  });
}

export function createHistoryModule({
  els,
  state,
  photoViewer,
  handleSessionExpired,
  renderStatusBanner,
  canWorkerEditRecord,
  handleWorkerEditRecord,
  handleWorkerDeleteRecord,
  handleSupervisorEditRecord,
  handleSupervisorDecision
}) {
  function fromBackendAttendanceRecord(record) {
    const site = state.sites.find((item) => getBackendSiteId(item.id) === record.site_id);

    return {
      id: record.id,
      backendRecordId: record.id,
      type: 'attendance',
      userId: record.worker_id,
      userName: record.worker_name || `Worker ${record.worker_id}`,
      siteId: record.site_id,
      siteName: record.site_name || site?.name || (record.site_id ? `Site ${record.site_id}` : 'Unassigned site'),
      action: record.record_type,
      notes: record.note || '',
      photoDataUrl: '',
      photoUrl: record.photo_url || '',
      location: {
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: record.accuracy
      },
      distanceFromSiteM: record.distance_from_site_m,
      withinSiteRadius: record.within_site_radius,
      createdAt: record.created_at,
      syncStatus: 'synced',
      status: record.status || 'pending',
      source: 'backend'
    };
  }

  function fromBackendTaskLogRecord(record) {
    const site = state.sites.find((item) => getBackendSiteId(item.id) === record.site_id);

    return {
      id: `task-${record.id}`,
      backendRecordId: record.id,
      type: 'task',
      userId: record.worker_id,
      userName: record.worker_name || `Worker ${record.worker_id}`,
      siteId: record.site_id,
      siteName: record.site_name || site?.name || (record.site_id ? `Site ${record.site_id}` : 'Unassigned site'),
      workDate: record.work_date || '',
      hoursWorked: record.hours_worked == null ? '' : String(record.hours_worked),
      summary: record.description || '',
      safetyNotes: record.safety_notes || '',
      photoDataUrl: '',
      photoDataUrls: [],
      photoUrl: record.photo_url || '',
      photoUrls: record.photo_urls || (record.photo_url ? [record.photo_url] : []),
      createdAt: record.created_at,
      syncStatus: 'synced',
      status: record.status || 'pending',
      source: 'backend'
    };
  }

  function fromBackendFormSubmissionRecord(record) {
    const site = state.sites.find((item) => getBackendSiteId(item.id) === record.site_id);

    return {
      id: `form-${record.id}`,
      backendRecordId: record.id,
      type: 'form',
      formId: record.form_id,
      formName: record.form_name || `Form ${record.form_id}`,
      fields: record.fields || [],
      answers: record.answers || {},
      userId: record.worker_id,
      userName: record.worker_name || `Worker ${record.worker_id}`,
      siteId: record.site_id,
      siteName: record.site_name || site?.name || (record.site_id ? `Site ${record.site_id}` : 'Unassigned site'),
      workDate: record.work_date || '',
      summary: '',
      safetyNotes: '',
      photoDataUrls: [],
      photoUrl: record.photo_urls?.[0] || '',
      photoUrls: record.photo_urls || [],
      createdAt: record.created_at,
      syncStatus: 'synced',
      status: record.status || 'pending',
      source: 'backend'
    };
  }

  function fromBackendReviewRecord(record) {
    if (record.kind === 'attendance') {
      return fromBackendAttendanceRecord(record);
    }

    if (record.kind === 'task') {
      return fromBackendTaskLogRecord(record);
    }

    if (record.kind === 'form') {
      return fromBackendFormSubmissionRecord(record);
    }

    return null;
  }

  async function getWorkerHistoryRecords() {
    try {
      const [attendanceRecords, taskLogs, formSubmissions, localRecords] = await Promise.all([
        getBackendMyAttendanceRecords(),
        getBackendMyTaskLogs(),
        getBackendMyFormSubmissions(),
        getLocalWorkerRecords(state.user.id)
      ]);

      const queuedLocalRecords = localRecords.filter((record) => record.syncStatus === 'queued');
      return attendanceRecords
        .map(fromBackendAttendanceRecord)
        .concat(
          taskLogs.map(fromBackendTaskLogRecord),
          formSubmissions.map(fromBackendFormSubmissionRecord),
          queuedLocalRecords
        )
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleSessionExpired();
        return [];
      }

      renderStatusBanner('Backend history is unreachable. Showing records saved on this device only.', true);
      return await getLocalWorkerRecords(state.user.id);
    }
  }

  async function renderWorkerSummary() {
    if (!state.user) return;
    const records = await getWorkerHistoryRecords();
    const today = todayDateInput();
    const todayRecords = records.filter((record) => getRecordDate(record) === today);
    const queuedCount = records.filter((record) => record.syncStatus === 'queued').length;
    const latestCheckIn = records.find((record) => record.type === 'attendance' && record.action === 'check_in');
    const latestCheckOut = records.find((record) => record.type === 'attendance' && record.action === 'check_out');

    els.workerSummary.innerHTML = `
      <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
      <div class="summary-item"><span>Entries today</span><strong>${todayRecords.length}</strong></div>
      <div class="summary-item"><span>Last check in</span><strong>${latestCheckIn ? formatDateTime(latestCheckIn.createdAt) : '-'}</strong></div>
      <div class="summary-item"><span>Last check out</span><strong>${latestCheckOut ? formatDateTime(latestCheckOut.createdAt) : '-'}</strong></div>
      <div class="summary-item"><span>Queued offline</span><strong>${queuedCount}</strong></div>
    `;
  }

  function getHistoryFilters() {
    return {
      query: els.historySearchInput.value,
      type: els.historyTypeFilter.value,
      status: els.historyStatusFilter.value,
      date: els.historyDateFilter.value
    };
  }

  async function renderHistory() {
    if (!state.user) return;
    state.historyRecords = await getWorkerHistoryRecords();
    renderFilteredHistory();
  }

  function renderFilteredHistory() {
    const filteredRecords = filterRecords(state.historyRecords, getHistoryFilters());
    els.historyResultCount.textContent = `${filteredRecords.length} of ${state.historyRecords.length} records`;
    renderRecordsList(els.historyList, filteredRecords, {
      showWorkerActions: true
    });
  }

  function clearHistoryFilters() {
    els.historySearchInput.value = '';
    els.historyTypeFilter.value = '';
    els.historyStatusFilter.value = '';
    els.historyDateFilter.value = '';
    renderFilteredHistory();
  }

  function renderRecordsList(container, records, options = {}) {
    const showDecisionActions = typeof options === 'boolean' ? options : Boolean(options.showDecisionActions);
    const showEditActions = typeof options === 'object' && Boolean(options.showEditActions);
    const showWorkerActions = typeof options === 'object' && Boolean(options.showWorkerActions);
    container.innerHTML = '';
    if (!records.length) {
      container.innerHTML = '<div class="empty-state">No records found yet.</div>';
      return;
    }

    records.forEach((record) => {
      const node = els.recordTemplate.content.firstElementChild.cloneNode(true);
      node.classList.add(
        record.type === 'form'
          ? 'record-form'
          : record.type === 'task'
          ? 'record-task'
          : record.action === 'check_out'
            ? 'record-check-out'
            : 'record-check-in'
      );
      const title = record.type === 'attendance'
        ? `${record.action === 'check_in' ? 'Check in' : 'Check out'} - ${record.siteName}`
        : record.type === 'form'
          ? `${record.formName} - ${record.siteName}`
          : `Task log - ${record.siteName}`;
      const detail = record.type === 'attendance'
        ? record.notes || 'No notes added.'
        : record.type === 'form'
          ? formAnswerSummary(record) || 'No answers provided.'
          : `${record.summary || 'No summary provided.'}${record.safetyNotes ? ` Safety: ${record.safetyNotes}` : ''}`;

      node.querySelector('.record-title').textContent = title;
      node.querySelector('.record-meta').textContent = `${record.userName || 'Worker'}  |  ${formatDateTime(record.createdAt)}${record.workDate ? `  |  Work date: ${record.workDate}` : ''}`;
      node.querySelector('.record-detail').textContent = detail;

      const badge = node.querySelector('.badge');
      const badgeText = record.status || record.syncStatus || 'record';
      badge.textContent = badgeText;
      badge.className = `badge ${record.status} ${record.syncStatus}`;
      badge.title = record.syncStatus ? `Sync: ${record.syncStatus}` : '';

      const extra = node.querySelector('.record-extra');
      const photoSources = (Array.isArray(record.photoDataUrls) && record.photoDataUrls.length)
        ? record.photoDataUrls
        : (normaliseRecordPhotoUrls(record).length ? normaliseRecordPhotoUrls(record) : (record.photoDataUrl ? [record.photoDataUrl] : []));
      const signatureSources = signatureImageSources(record);
      const hasSiteDistance = record.type === 'attendance' && record.distanceFromSiteM != null;
      extra.innerHTML = `
        <p><strong>Type:</strong> ${record.type === 'attendance' ? escapeHtml(record.action === 'check_in' ? 'Check in' : 'Check out') : record.type === 'form' ? 'Form submission' : 'Task log'}</p>
        ${record.type === 'attendance' && record.location ? `<p><strong>Location:</strong> ${record.location.latitude}, ${record.location.longitude} (${record.location.accuracy}m)</p>` : ''}
        ${hasSiteDistance ? `<p><strong>Site radius:</strong> <span class="${record.withinSiteRadius ? 'site-inside' : 'site-outside'}">${record.withinSiteRadius ? 'Inside' : 'Outside'} - ${escapeHtml(record.distanceFromSiteM)}m from site</span></p>` : ''}
        ${record.hoursWorked ? `<p><strong>Hours:</strong> ${escapeHtml(record.hoursWorked)}</p>` : ''}
        ${record.type === 'form' ? `<p><strong>Form:</strong> ${escapeHtml(record.formName)}</p>` : ''}
        ${record.syncStatus ? `<p><strong>Sync:</strong> ${escapeHtml(record.syncStatus)}</p>` : ''}
        ${signatureSources.length ? `<div class="record-signatures">${signatureSources.map((signature, index) => `
          <button class="photo-thumb" type="button" data-signature-index="${index}">
            <img src="${escapeHtml(signature.src)}" alt="${escapeHtml(signature.label)}" />
          </button>
        `).join('')}</div>` : ''}
        ${photoSources.length ? `<div class="record-photos">${photoSources.map((photoSrc, index) => `
          <button class="photo-thumb" type="button" data-photo-index="${index}">
            <img src="${escapeHtml(photoSrc)}" alt="Record photo ${index + 1}" />
          </button>
        `).join('')}</div>` : ''}
      `;
      extra.querySelectorAll('[data-photo-index]').forEach((button) => {
        button.addEventListener('click', () => {
          photoViewer.open(photoSources, Number(button.dataset.photoIndex || 0), title);
        });
      });
      extra.querySelectorAll('[data-signature-index]').forEach((button) => {
        button.addEventListener('click', () => {
          photoViewer.open(signatureSources.map((signature) => signature.src), Number(button.dataset.signatureIndex || 0), `${title} signature`);
        });
      });

      const actions = node.querySelector('.record-actions');
      const canShowWorkerActions = showWorkerActions && canWorkerEditRecord(record);
      const canShowSupervisorEdit = showEditActions && (record.type === 'attendance' || record.type === 'task');
      const canShowDecision = showDecisionActions && record.status === 'pending';
      if (canShowDecision || canShowSupervisorEdit || canShowWorkerActions) {
        actions.classList.remove('hidden');
      }

      if (canShowWorkerActions) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'ghost';
        editButton.textContent = 'Edit';
        editButton.addEventListener('click', async () => {
          await handleWorkerEditRecord(record);
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'secondary';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', async () => {
          await handleWorkerDeleteRecord(record);
        });

        actions.append(editButton, deleteButton);
      }

      if (canShowSupervisorEdit) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'ghost';
        editButton.textContent = 'Edit';
        editButton.addEventListener('click', async () => {
          await handleSupervisorEditRecord(record);
        });
        actions.append(editButton);
      }

      if (canShowDecision) {
        const approveButton = document.createElement('button');
        approveButton.type = 'button';
        approveButton.textContent = 'Approve';
        approveButton.addEventListener('click', async () => {
          await handleSupervisorDecision(record, 'approved');
        });

        const rejectButton = document.createElement('button');
        rejectButton.type = 'button';
        rejectButton.textContent = 'Reject';
        rejectButton.className = 'secondary';
        rejectButton.addEventListener('click', async () => {
          await handleSupervisorDecision(record, 'rejected');
        });

        actions.append(approveButton, rejectButton);
      }

      container.appendChild(node);
    });
  }

  function bindEvents() {
    els.refreshHistoryButton.addEventListener('click', renderHistory);
    [
      els.historySearchInput,
      els.historyTypeFilter,
      els.historyStatusFilter,
      els.historyDateFilter
    ].forEach((element) => {
      element.addEventListener('input', renderFilteredHistory);
      element.addEventListener('change', renderFilteredHistory);
    });
    els.clearHistoryFiltersButton.addEventListener('click', clearHistoryFilters);
  }

  return {
    bindEvents,
    filterRecords,
    fromBackendReviewRecord,
    getRecordDate,
    renderHistory,
    renderFilteredHistory,
    renderRecordsList,
    renderWorkerSummary
  };
}
