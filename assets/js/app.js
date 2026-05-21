import {
  initializeMockData,
  getSites as getLocalSites,
  saveDraft,
  getDraft,
  clearDraft,
  createAttendanceRecord,
  createTaskLog as createLocalTaskLog,
  flushQueueWith,
  getWorkerRecords as getLocalWorkerRecords,
  getPendingApprovals,
  getReviewedApprovals,
  getTaskLogRecords,
  decideRecord as decideLocalRecord,
  getLastSyncAt
} from './mock-api.js';
import {
  login as backendLogin,
  register as backendRegister,
  getSession as getBackendSession,
  getCurrentUser,
  getUsers as getBackendUsers,
  createUser as createBackendUser,
  getSites as getBackendSites,
  createSite as createBackendSite,
  uploadPhoto,
  createAttendance as createBackendAttendance,
  getMyRecords as getBackendMyAttendanceRecords,
  createTaskLog as createBackendTaskLog,
  getMyTaskLogs as getBackendMyTaskLogs,
  getSupervisorRecords as getBackendSupervisorRecords,
  exportSupervisorRecordsCsv,
  getSupervisorTaskLogs as getBackendSupervisorTaskLogs,
  decideRecord as decideBackendRecord,
  logout as clearBackendSession
} from './api-client.js';
import { dataUrlToBlob, fileToDataUrl, formatDateTime, todayDateInput, uuid, escapeHtml } from './utils.js';

const state = {
  user: null,
  sites: [],
  installPrompt: null,
  attendanceLocation: null,
  attendancePhotoDataUrl: '',
  attendancePhotoFile: null,
  taskPhotoFile: null,
  taskPhotoDataUrl: '',
  historyRecords: [],
  supervisorRecords: {
    pending: [],
    reviewed: [],
    taskLogs: []
  }
};

const els = {
  statusBanner: document.getElementById('statusBanner'),
  installButton: document.getElementById('installButton'),
  logoutButton: document.getElementById('logoutButton'),
  loginView: document.getElementById('loginView'),
  workerView: document.getElementById('workerView'),
  supervisorView: document.getElementById('supervisorView'),
  loginForm: document.getElementById('loginForm'),
  emailInput: document.getElementById('emailInput'),
  passwordInput: document.getElementById('passwordInput'),
  registerForm: document.getElementById('registerForm'),
  registerNameInput: document.getElementById('registerNameInput'),
  registerEmailInput: document.getElementById('registerEmailInput'),
  registerPasswordInput: document.getElementById('registerPasswordInput'),
  attendanceSite: document.getElementById('attendanceSite'),
  attendanceNotes: document.getElementById('attendanceNotes'),
  attendanceDetails: document.getElementById('attendanceDetails'),
  attendancePhoto: document.getElementById('attendancePhoto'),
  attendancePhotoPreview: document.getElementById('attendancePhotoPreview'),
  locationPreview: document.getElementById('locationPreview'),
  captureLocationButton: document.getElementById('captureLocationButton'),
  saveAttendanceDraftButton: document.getElementById('saveAttendanceDraftButton'),
  checkInButton: document.getElementById('checkInButton'),
  checkOutButton: document.getElementById('checkOutButton'),
  workerSummary: document.getElementById('workerSummary'),
  historyList: document.getElementById('historyList'),
  refreshHistoryButton: document.getElementById('refreshHistoryButton'),
  historySearchInput: document.getElementById('historySearchInput'),
  historyTypeFilter: document.getElementById('historyTypeFilter'),
  historyStatusFilter: document.getElementById('historyStatusFilter'),
  historyDateFilter: document.getElementById('historyDateFilter'),
  historyResultCount: document.getElementById('historyResultCount'),
  clearHistoryFiltersButton: document.getElementById('clearHistoryFiltersButton'),
  taskForm: document.getElementById('taskForm'),
  taskSite: document.getElementById('taskSite'),
  taskDate: document.getElementById('taskDate'),
  taskHours: document.getElementById('taskHours'),
  taskSummary: document.getElementById('taskSummary'),
  taskSafety: document.getElementById('taskSafety'),
  taskPhoto: document.getElementById('taskPhoto'),
  taskPhotoPreview: document.getElementById('taskPhotoPreview'),
  saveTaskDraftButton: document.getElementById('saveTaskDraftButton'),
  supervisorSummary: document.getElementById('supervisorSummary'),
  pendingApprovalsList: document.getElementById('pendingApprovalsList'),
  reviewedApprovalsList: document.getElementById('reviewedApprovalsList'),
  supervisorTaskLogsList: document.getElementById('supervisorTaskLogsList'),
  supervisorSearchInput: document.getElementById('supervisorSearchInput'),
  supervisorTypeFilter: document.getElementById('supervisorTypeFilter'),
  supervisorStatusFilter: document.getElementById('supervisorStatusFilter'),
  supervisorDateFilter: document.getElementById('supervisorDateFilter'),
  supervisorResultCount: document.getElementById('supervisorResultCount'),
  pendingApprovalsCount: document.getElementById('pendingApprovalsCount'),
  reviewedApprovalsCount: document.getElementById('reviewedApprovalsCount'),
  supervisorTaskLogsCount: document.getElementById('supervisorTaskLogsCount'),
  supervisorSitesCount: document.getElementById('supervisorSitesCount'),
  staffUsersCount: document.getElementById('staffUsersCount'),
  clearSupervisorFiltersButton: document.getElementById('clearSupervisorFiltersButton'),
  exportAttendanceButton: document.getElementById('exportAttendanceButton'),
  staffUserForm: document.getElementById('staffUserForm'),
  staffNameInput: document.getElementById('staffNameInput'),
  staffEmailInput: document.getElementById('staffEmailInput'),
  staffPasswordInput: document.getElementById('staffPasswordInput'),
  staffRoleSelect: document.getElementById('staffRoleSelect'),
  staffUsersList: document.getElementById('staffUsersList'),
  siteForm: document.getElementById('siteForm'),
  siteNameInput: document.getElementById('siteNameInput'),
  siteAddressInput: document.getElementById('siteAddressInput'),
  siteLatitudeInput: document.getElementById('siteLatitudeInput'),
  siteLongitudeInput: document.getElementById('siteLongitudeInput'),
  siteRadiusInput: document.getElementById('siteRadiusInput'),
  supervisorSitesList: document.getElementById('supervisorSitesList'),
  refreshSupervisorButton: document.getElementById('refreshSupervisorButton'),
  recordTemplate: document.getElementById('recordTemplate')
};

async function init() {
  await initializeMockData();
  state.sites = await loadSites();
  fillSiteSelects();
  const authRestoreMessage = await restoreBackendSession();
  els.taskDate.value = todayDateInput();
  await restoreDrafts();
  bindEvents();
  await syncQueueIfPossible(false);
  renderApp();
  if (authRestoreMessage) {
    renderStatusBanner(authRestoreMessage, !navigator.onLine);
  }
  registerServiceWorker();
}

async function loadSites() {
  try {
    const sites = await getBackendSites();
    if (sites.length) return sites;
  } catch {
    // Use local demo sites when the backend is unavailable or before seed data exists.
  }

  return await getLocalSites();
}

async function restoreBackendSession() {
  const cachedUser = getBackendSession();
  if (!cachedUser) return '';

  state.user = cachedUser;

  try {
    state.user = await getCurrentUser();
    return '';
  } catch (error) {
    if (!navigator.onLine) {
      return 'Using your saved sign-in while offline. Some backend features will sync when you reconnect.';
    }

    if (error.status === 401 || error.status === 403) {
      clearBackendSession();
      state.user = null;
      return 'Your saved backend session expired. Please sign in again.';
    }

    return error.message;
  }
}

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.registerForm.addEventListener('submit', handleRegister);
  els.logoutButton.addEventListener('click', handleLogout);
  els.captureLocationButton.addEventListener('click', handleCaptureLocation);
  els.saveAttendanceDraftButton.addEventListener('click', persistAttendanceDraft);
  els.checkInButton.addEventListener('click', () => submitAttendance('check_in'));
  els.checkOutButton.addEventListener('click', () => submitAttendance('check_out'));
  els.attendancePhoto.addEventListener('change', handleAttendancePhotoChange);
  els.taskPhoto.addEventListener('change', handleTaskPhotoChange);
  els.taskForm.addEventListener('submit', handleTaskSubmit);
  els.saveTaskDraftButton.addEventListener('click', persistTaskDraft);
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
  els.refreshSupervisorButton.addEventListener('click', renderSupervisorPanel);
  [
    els.supervisorSearchInput,
    els.supervisorTypeFilter,
    els.supervisorStatusFilter,
    els.supervisorDateFilter
  ].forEach((element) => {
    element.addEventListener('input', renderFilteredSupervisorLists);
    element.addEventListener('change', renderFilteredSupervisorLists);
  });
  els.clearSupervisorFiltersButton.addEventListener('click', clearSupervisorFilters);
  els.exportAttendanceButton.addEventListener('click', handleExportAttendance);
  els.staffUserForm.addEventListener('submit', handleStaffUserCreate);
  els.siteForm.addEventListener('submit', handleSiteCreate);
  els.installButton.addEventListener('click', handleInstall);

  document.querySelectorAll('[data-tab-target]').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.tabTarget));
  });

  window.addEventListener('online', async () => {
    await syncQueueIfPossible(true);
    renderStatusBanner('You are back online. Queued records have been checked for sync.');
    renderApp();
  });

  window.addEventListener('offline', () => {
    renderStatusBanner('You are offline. New submissions will stay on this device until you reconnect.', true);
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installButton.classList.remove('hidden');
  });
}

function fillSiteSelects() {
  const options = ['<option value="">Select a site</option>']
    .concat(
      state.sites.map(
        (site) => `<option value="${site.id}">${escapeHtml(site.name)} - ${escapeHtml(site.address)}</option>`
      )
    )
    .join('');

  els.attendanceSite.innerHTML = options;
  els.taskSite.innerHTML = options;
}

function findSiteByFormValue(siteId) {
  return state.sites.find((item) => String(item.id) === String(siteId));
}

async function restoreDrafts() {
  const attendanceDraft = await getDraft('attendance-form');
  if (attendanceDraft) {
    els.attendanceSite.value = attendanceDraft.siteId || '';
    els.attendanceNotes.value = attendanceDraft.notes || '';
    state.attendanceLocation = attendanceDraft.location || null;
    state.attendancePhotoDataUrl = attendanceDraft.photoDataUrl || '';
    els.attendanceDetails.open = Boolean(attendanceDraft.notes || attendanceDraft.photoDataUrl);
    renderLocationPreview();
    renderPhotoPreview(els.attendancePhotoPreview, state.attendancePhotoDataUrl, 'Attendance draft photo');
  }

  const taskDraft = await getDraft('task-form');
  if (taskDraft) {
    els.taskSite.value = taskDraft.siteId || '';
    els.taskDate.value = taskDraft.workDate || todayDateInput();
    els.taskHours.value = taskDraft.hoursWorked || '';
    els.taskSummary.value = taskDraft.summary || '';
    els.taskSafety.value = taskDraft.safetyNotes || '';
    state.taskPhotoDataUrl = taskDraft.photoDataUrl || '';
    renderPhotoPreview(els.taskPhotoPreview, state.taskPhotoDataUrl, 'Task draft photo');
  }
}

function renderApp() {
  updateTopbar();
  if (!state.user) {
    showView('login');
    renderStatusBanner(navigator.onLine ? 'Ready for sign in.' : 'Offline mode is active. Login still works only if this browser session already has data cached.', !navigator.onLine);
    return;
  }

  if (state.user.role === 'worker') {
    showView('worker');
    renderWorkerSummary();
    renderHistory();
  } else {
    showView('supervisor');
    renderSupervisorPanel();
  }

  refreshStatusBannerForSession();
}

function showView(view) {
  const map = {
    login: els.loginView,
    worker: els.workerView,
    supervisor: els.supervisorView
  };

  Object.values(map).forEach((element) => {
    element.classList.add('hidden');
    element.classList.remove('active');
  });

  map[view].classList.remove('hidden');
  map[view].classList.add('active');
}

function updateTopbar() {
  if (state.user) {
    els.logoutButton.classList.remove('hidden');
  } else {
    els.logoutButton.classList.add('hidden');
  }
}

function renderStatusBanner(message, offline = false) {
  els.statusBanner.textContent = message;
  els.statusBanner.classList.toggle('offline', offline);
}

async function refreshStatusBannerForSession() {
  const lastSyncAt = await getLastSyncAt();
  const base = state.user
    ? `${state.user.fullName} is signed in as ${state.user.role}.`
    : 'No user signed in.';
  const syncPart = lastSyncAt ? ` Last local sync: ${formatDateTime(lastSyncAt)}.` : ' No sync has run yet.';
  renderStatusBanner(
    navigator.onLine ? `${base}${syncPart}` : `${base} Offline mode is active. Queued entries will sync later.`,
    !navigator.onLine
  );
}

async function handleLogin(event) {
  event.preventDefault();
  try {
    renderStatusBanner('Signing in with the backend...');
    state.user = await backendLogin(els.emailInput.value.trim(), els.passwordInput.value);
    renderApp();
  } catch (error) {
    renderStatusBanner(error.message, false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  try {
    renderStatusBanner('Creating staff account...');
    state.user = await backendRegister(
      els.registerNameInput.value.trim(),
      els.registerEmailInput.value.trim(),
      els.registerPasswordInput.value
    );
    els.registerForm.reset();
    renderApp();
  } catch (error) {
    renderStatusBanner(error.message, false);
  }
}

function handleLogout() {
  clearBackendSession();
  state.user = null;
  renderApp();
}

async function handleCaptureLocation() {
  if (!navigator.geolocation) {
    renderStatusBanner('Geolocation is not available in this browser.', false);
    return;
  }

  renderStatusBanner('Capturing current location...');
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      state.attendanceLocation = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        accuracy: Math.round(position.coords.accuracy),
        capturedAt: new Date(position.timestamp).toISOString()
      };
      renderLocationPreview();
      await persistAttendanceDraft();
      renderStatusBanner(`Location captured successfully with approximately ${state.attendanceLocation.accuracy}m accuracy.`);
    },
    (error) => {
      renderStatusBanner(`Could not get location: ${error.message}`, false);
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    }
  );
}

function renderLocationPreview() {
  if (!state.attendanceLocation) {
    els.locationPreview.textContent = 'No location captured yet.';
    return;
  }
  const loc = state.attendanceLocation;
  els.locationPreview.innerHTML = `
    <strong>Captured location</strong><br />
    Latitude: ${loc.latitude}<br />
    Longitude: ${loc.longitude}<br />
    Accuracy: ${loc.accuracy}m<br />
    Time: ${formatDateTime(loc.capturedAt)}
  `;
}

async function handleAttendancePhotoChange(event) {
  const file = event.target.files?.[0];
  state.attendancePhotoFile = file || null;
  state.attendancePhotoDataUrl = file ? await fileToDataUrl(file) : '';
  renderPhotoPreview(els.attendancePhotoPreview, state.attendancePhotoDataUrl, 'Attendance photo');
  await persistAttendanceDraft();
}

async function handleTaskPhotoChange(event) {
  const file = event.target.files?.[0];
  state.taskPhotoFile = file || null;
  state.taskPhotoDataUrl = file ? await fileToDataUrl(file) : '';
  renderPhotoPreview(els.taskPhotoPreview, state.taskPhotoDataUrl, 'Task photo');
  await persistTaskDraft();
}

function renderPhotoPreview(container, dataUrl, alt) {
  if (!dataUrl) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(alt)}" />`;
}

async function persistAttendanceDraft() {
  await saveDraft('attendance-form', {
    siteId: els.attendanceSite.value,
    notes: els.attendanceNotes.value,
    location: state.attendanceLocation,
    photoDataUrl: state.attendancePhotoDataUrl
  });
  renderStatusBanner('Attendance draft saved on this device.');
}

async function persistTaskDraft() {
  await saveDraft('task-form', {
    siteId: els.taskSite.value,
    workDate: els.taskDate.value,
    hoursWorked: els.taskHours.value,
    summary: els.taskSummary.value,
    safetyNotes: els.taskSafety.value,
    photoDataUrl: state.taskPhotoDataUrl
  });
  renderStatusBanner('Task log draft saved on this device.');
}

function getBackendSiteId(siteId) {
  if (!siteId) return null;

  const directId = Number(siteId);
  return Number.isInteger(directId) ? directId : null;
}

function distanceBetweenCoordinatesM(startLatitude, startLongitude, endLatitude, endLongitude) {
  const earthRadiusM = 6371000;
  const startLat = startLatitude * Math.PI / 180;
  const endLat = endLatitude * Math.PI / 180;
  const deltaLat = (endLatitude - startLatitude) * Math.PI / 180;
  const deltaLon = (endLongitude - startLongitude) * Math.PI / 180;
  const a = (
    Math.sin(deltaLat / 2) ** 2
    + Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2
  );
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function getSiteDistanceCheck(site, location) {
  if (!site || !location || site.latitude == null || site.longitude == null) {
    return {
      distanceFromSiteM: null,
      withinSiteRadius: null
    };
  }

  const allowedRadius = Number(site.allowed_radius_m || site.allowedRadiusM || 100);
  const distanceFromSiteM = Math.round(
    distanceBetweenCoordinatesM(
      Number(site.latitude),
      Number(site.longitude),
      Number(location.latitude),
      Number(location.longitude)
    )
  );

  return {
    distanceFromSiteM,
    withinSiteRadius: distanceFromSiteM <= allowedRadius
  };
}

function toBackendAttendancePayload(record) {
  return {
    record_type: record.action,
    latitude: record.location.latitude,
    longitude: record.location.longitude,
    accuracy: record.location.accuracy,
    site_id: getBackendSiteId(record.siteId),
    note: record.notes || null,
    photo_url: record.photoUrl || null
  };
}

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

function toBackendTaskLogPayload(record) {
  return {
    description: record.summary,
    site_id: getBackendSiteId(record.siteId),
    work_date: record.workDate || null,
    hours_worked: record.hoursWorked ? Number(record.hoursWorked) : null,
    safety_notes: record.safetyNotes || null,
    photo_url: record.photoUrl || null
  };
}

function photoFilenameFor(record, file) {
  if (file?.name) return file.name;
  const extension = record.photoDataUrl?.match(/^data:image\/([a-z0-9+.-]+);base64,/i)?.[1] || 'jpg';
  return `${record.type || 'record'}-${record.id || uuid()}.${extension.replace('jpeg', 'jpg')}`;
}

async function uploadRecordPhoto(record, file = null) {
  if (record.photoUrl) return record.photoUrl;

  const source = file || (record.photoDataUrl ? dataUrlToBlob(record.photoDataUrl) : null);
  if (!source) return null;

  const uploaded = await uploadPhoto(source, photoFilenameFor(record, file));
  record.photoUrl = uploaded.url;
  return record.photoUrl;
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
    photoUrl: record.photo_url || '',
    createdAt: record.created_at,
    syncStatus: 'synced',
    status: record.status || 'logged',
    source: 'backend'
  };
}

async function getWorkerHistoryRecords() {
  try {
    const [attendanceRecords, taskLogs, localRecords] = await Promise.all([
      getBackendMyAttendanceRecords(),
      getBackendMyTaskLogs(),
      getLocalWorkerRecords(state.user.id)
    ]);

    const queuedLocalRecords = localRecords.filter((record) => record.syncStatus === 'queued');
    return attendanceRecords
      .map(fromBackendAttendanceRecord)
      .concat(taskLogs.map(fromBackendTaskLogRecord), queuedLocalRecords)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearBackendSession();
      state.user = null;
      renderApp();
      renderStatusBanner('Your backend session expired. Please sign in again.');
      return [];
    }

    renderStatusBanner('Backend history is unreachable. Showing records saved on this device only.', true);
    return await getLocalWorkerRecords(state.user.id);
  }
}

async function submitAttendance(action) {
  if (!state.user) return;
  if (!els.attendanceSite.value) {
    renderStatusBanner('Please select a site first.');
    return;
  }
  if (!state.attendanceLocation) {
    renderStatusBanner('Please capture your location before submitting attendance.');
    return;
  }

  const site = findSiteByFormValue(els.attendanceSite.value);
  if (!site) {
    renderStatusBanner('Please select a valid site first.');
    return;
  }

  const localRecord = {
    id: uuid(),
    type: 'attendance',
    userId: state.user.id,
    userName: state.user.fullName,
    siteId: site.id,
    siteName: site.name,
    action,
    notes: els.attendanceNotes.value.trim(),
    photoDataUrl: state.attendancePhotoDataUrl,
    location: state.attendanceLocation,
    createdAt: new Date().toISOString()
  };
  Object.assign(localRecord, getSiteDistanceCheck(site, localRecord.location));

  let successMessage = `${action === 'check_in' ? 'Check in' : 'Check out'} saved offline and queued for later sync.`;
  let offlineStatus = true;

  if (navigator.onLine) {
    try {
      await uploadRecordPhoto(localRecord, state.attendancePhotoFile);
      const backendRecord = await createBackendAttendance(toBackendAttendancePayload(localRecord));
      localRecord.syncStatus = 'synced';
      localRecord.backendRecordId = backendRecord.id;
      localRecord.status = backendRecord.status || 'pending';
      localRecord.distanceFromSiteM = backendRecord.distance_from_site_m;
      localRecord.withinSiteRadius = backendRecord.within_site_radius;
      localRecord.syncedAt = new Date().toISOString();
      successMessage = `${action === 'check_in' ? 'Check in' : 'Check out'} saved to the backend and marked ready for supervisor review.`;
      offlineStatus = false;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        renderStatusBanner('Your backend session expired. Please sign in again.');
        return;
      }

      localRecord.syncStatus = 'queued';
      localRecord.syncError = error.message || 'Backend sync failed';
      successMessage = `${action === 'check_in' ? 'Check in' : 'Check out'} saved locally. Backend sync will retry when you reconnect.`;
      offlineStatus = true;
    }
  } else {
    localRecord.syncStatus = 'queued';
  }

  await createAttendanceRecord(localRecord);

  await clearDraft('attendance-form');
  resetAttendanceForm();
  await syncQueueIfPossible(true);
  renderStatusBanner(successMessage, offlineStatus);
  renderWorkerSummary();
  renderHistory();
}

function resetAttendanceForm() {
  els.attendanceSite.value = '';
  els.attendanceNotes.value = '';
  els.attendancePhoto.value = '';
  state.attendancePhotoDataUrl = '';
  state.attendancePhotoFile = null;
  state.attendanceLocation = null;
  renderLocationPreview();
  renderPhotoPreview(els.attendancePhotoPreview, '', '');
}

async function handleTaskSubmit(event) {
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
    photoDataUrl: state.taskPhotoDataUrl,
    createdAt: new Date().toISOString()
  };

  let successMessage = 'Task log saved offline and queued for later sync.';
  let offlineStatus = true;

  if (navigator.onLine) {
    try {
      await uploadRecordPhoto(localRecord, state.taskPhotoFile);
      const backendLog = await createBackendTaskLog(toBackendTaskLogPayload(localRecord));
      localRecord.syncStatus = 'synced';
      localRecord.backendRecordId = backendLog.id;
      localRecord.status = backendLog.status || 'logged';
      localRecord.syncedAt = new Date().toISOString();
      successMessage = 'Task log saved to the backend.';
      offlineStatus = false;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        renderStatusBanner('Your backend session expired. Please sign in again.');
        return;
      }

      localRecord.syncStatus = 'queued';
      localRecord.syncError = error.message || 'Backend sync failed';
      successMessage = 'Task log saved locally. Backend sync will retry when you reconnect.';
      offlineStatus = true;
    }
  } else {
    localRecord.syncStatus = 'queued';
  }

  await createLocalTaskLog(localRecord);

  await clearDraft('task-form');
  resetTaskForm();
  await syncQueueIfPossible(true);
  renderStatusBanner(successMessage, offlineStatus);
  renderWorkerSummary();
  renderHistory();
}

function resetTaskForm() {
  els.taskSite.value = '';
  els.taskDate.value = todayDateInput();
  els.taskHours.value = '';
  els.taskSummary.value = '';
  els.taskSafety.value = '';
  els.taskPhoto.value = '';
  state.taskPhotoDataUrl = '';
  state.taskPhotoFile = null;
  renderPhotoPreview(els.taskPhotoPreview, '', '');
}

async function renderWorkerSummary() {
  if (!state.user) return;
  const records = await getWorkerHistoryRecords();
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = records.filter((record) => record.createdAt.slice(0, 10) === today || record.workDate === today);
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

function getRecordDate(record) {
  return record.workDate || record.createdAt?.slice(0, 10) || '';
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
    record.notes,
    record.summary,
    record.safetyNotes,
    record.workDate,
    record.hoursWorked
  ].join(' ').toLowerCase();
}

function filterRecords(records, filters) {
  const query = filters.query.trim().toLowerCase();

  return records.filter((record) => {
    if (filters.type && record.type !== filters.type) return false;
    if (filters.date && getRecordDate(record) !== filters.date) return false;
    if (filters.status && record.status !== filters.status && record.syncStatus !== filters.status) return false;
    if (query && !recordSearchText(record).includes(query)) return false;
    return true;
  });
}

function getHistoryFilters() {
  return {
    query: els.historySearchInput.value,
    type: els.historyTypeFilter.value,
    status: els.historyStatusFilter.value,
    date: els.historyDateFilter.value
  };
}

function getSupervisorFilters() {
  return {
    query: els.supervisorSearchInput.value,
    type: els.supervisorTypeFilter.value,
    status: els.supervisorStatusFilter.value,
    date: els.supervisorDateFilter.value
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
  renderRecordsList(els.historyList, filteredRecords, false);
}

function clearHistoryFilters() {
  els.historySearchInput.value = '';
  els.historyTypeFilter.value = '';
  els.historyStatusFilter.value = '';
  els.historyDateFilter.value = '';
  renderFilteredHistory();
}

async function renderSupervisorPanel() {
  let pending;
  let reviewed;
  let taskLogs;
  let usingBackend = false;

  try {
    const [attendanceRecords, backendTaskLogs] = await Promise.all([
      getBackendSupervisorRecords(),
      getBackendSupervisorTaskLogs()
    ]);
    const records = attendanceRecords.map(fromBackendAttendanceRecord);
    pending = records.filter((record) => record.status === 'pending');
    reviewed = records.filter((record) => record.status === 'approved' || record.status === 'rejected');
    taskLogs = backendTaskLogs.map(fromBackendTaskLogRecord);
    usingBackend = true;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearBackendSession();
      state.user = null;
      renderApp();
      renderStatusBanner('Your backend session expired. Please sign in again.');
      return;
    }

    pending = await getPendingApprovals();
    reviewed = await getReviewedApprovals();
    taskLogs = await getTaskLogRecords();
    renderStatusBanner('Backend approvals are unreachable. Showing records saved on this device only.', true);
  }

  els.supervisorSummary.innerHTML = `
    <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
    <div class="summary-item"><span>Pending approvals</span><strong>${pending.length}</strong></div>
    <div class="summary-item"><span>Reviewed records</span><strong>${reviewed.length}</strong></div>
    <div class="summary-item"><span>Task logs</span><strong>${taskLogs.length}</strong></div>
    <div class="summary-item"><span>Source</span><strong>${usingBackend ? 'Backend' : 'This device'}</strong></div>
  `;
  state.supervisorRecords = { pending, reviewed, taskLogs };
  renderFilteredSupervisorLists();
  renderSupervisorSites();
  await renderStaffUsers();
}

function renderFilteredSupervisorLists() {
  const { pending, reviewed, taskLogs } = state.supervisorRecords;
  const filters = getSupervisorFilters();
  const filteredPending = filterRecords(pending, filters);
  const filteredReviewed = filterRecords(reviewed, filters);
  const filteredTaskLogs = filterRecords(taskLogs, filters);
  const total = pending.length + reviewed.length + taskLogs.length;
  const filteredTotal = filteredPending.length + filteredReviewed.length + filteredTaskLogs.length;

  els.supervisorResultCount.textContent = `${filteredTotal}/${total}`;
  els.pendingApprovalsCount.textContent = `${filteredPending.length}/${pending.length}`;
  els.reviewedApprovalsCount.textContent = `${filteredReviewed.length}/${reviewed.length}`;
  els.supervisorTaskLogsCount.textContent = `${filteredTaskLogs.length}/${taskLogs.length}`;
  renderRecordsList(els.pendingApprovalsList, filteredPending, true);
  renderRecordsList(els.reviewedApprovalsList, filteredReviewed, false);
  renderRecordsList(els.supervisorTaskLogsList, filteredTaskLogs, false);
}

function clearSupervisorFilters() {
  els.supervisorSearchInput.value = '';
  els.supervisorTypeFilter.value = '';
  els.supervisorStatusFilter.value = '';
  els.supervisorDateFilter.value = '';
  renderFilteredSupervisorLists();
}

function renderSupervisorSites() {
  els.supervisorSitesList.innerHTML = '';
  els.supervisorSitesCount.textContent = String(state.sites.length);

  if (!state.sites.length) {
    els.supervisorSitesList.innerHTML = '<div class="empty-state">No sites found yet.</div>';
    return;
  }

  state.sites.forEach((site) => {
    const node = document.createElement('article');
    node.className = 'record-card';
    node.innerHTML = `
      <div class="record-header">
        <div>
          <h3 class="record-title">${escapeHtml(site.name)}</h3>
          <p class="record-meta">${escapeHtml(site.address || 'No address added')}</p>
        </div>
        <span class="badge synced">${escapeHtml(site.allowed_radius_m || site.allowedRadiusM || 100)}m</span>
      </div>
      <p class="record-detail">Lat ${escapeHtml(site.latitude ?? '-')}, Lng ${escapeHtml(site.longitude ?? '-')}</p>
    `;
    els.supervisorSitesList.appendChild(node);
  });
}

async function renderStaffUsers() {
  try {
    const users = await getBackendUsers();
    els.staffUsersList.innerHTML = '';

    if (!users.length) {
      els.staffUsersCount.textContent = '0';
      els.staffUsersList.innerHTML = '<div class="empty-state">No users found yet.</div>';
      return;
    }

    els.staffUsersCount.textContent = String(users.length);
    users.forEach((user) => {
      const node = document.createElement('article');
      node.className = 'record-card';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(user.name)}</h3>
            <p class="record-meta">${escapeHtml(user.email)}</p>
          </div>
          <span class="badge synced">${escapeHtml(user.role)}</span>
        </div>
      `;
      els.staffUsersList.appendChild(node);
    });
  } catch (error) {
    els.staffUsersCount.textContent = '-';
    els.staffUsersList.innerHTML = '<div class="empty-state">Staff users are unavailable.</div>';
    renderStatusBanner(error.message || 'Could not load staff users.', true);
  }
}

async function handleSiteCreate(event) {
  event.preventDefault();

  const latitude = Number(els.siteLatitudeInput.value);
  const longitude = Number(els.siteLongitudeInput.value);
  const allowedRadius = Number(els.siteRadiusInput.value);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(allowedRadius)) {
    renderStatusBanner('Site latitude, longitude, and radius must be valid numbers.', true);
    return;
  }

  try {
    await createBackendSite({
      name: els.siteNameInput.value.trim(),
      address: els.siteAddressInput.value.trim() || null,
      latitude,
      longitude,
      allowed_radius_m: allowedRadius
    });
    els.siteForm.reset();
    els.siteRadiusInput.value = '100';
    state.sites = await loadSites();
    fillSiteSelects();
    renderSupervisorSites();
    renderStatusBanner('Site created and added to worker forms.');
  } catch (error) {
    renderStatusBanner(error.message || 'Could not create site.', true);
  }
}

async function handleStaffUserCreate(event) {
  event.preventDefault();
  try {
    await createBackendUser({
      name: els.staffNameInput.value.trim(),
      email: els.staffEmailInput.value.trim(),
      password: els.staffPasswordInput.value,
      role: els.staffRoleSelect.value
    });
    els.staffUserForm.reset();
    renderStatusBanner('Staff user created.');
    await renderStaffUsers();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not create staff user.', true);
  }
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

async function handleSupervisorDecision(record, decision) {
  try {
    if (record.backendRecordId) {
      await decideBackendRecord(record.backendRecordId, decision);
    } else {
      await decideLocalRecord(record.id, decision);
    }

    renderStatusBanner(`Record ${decision}.`);
    await renderSupervisorPanel();
  } catch (error) {
    renderStatusBanner(error.message || `Could not mark record as ${decision}.`, true);
  }
}

function renderRecordsList(container, records, showActions) {
  container.innerHTML = '';
  if (!records.length) {
    container.innerHTML = '<div class="empty-state">No records found yet.</div>';
    return;
  }

  records.forEach((record) => {
    const node = els.recordTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(
      record.type === 'task'
        ? 'record-task'
        : record.action === 'check_out'
          ? 'record-check-out'
          : 'record-check-in'
    );
    const title = record.type === 'attendance'
      ? `${record.action === 'check_in' ? 'Check in' : 'Check out'} - ${record.siteName}`
      : `Task log - ${record.siteName}`;
    const detail = record.type === 'attendance'
      ? record.notes || 'No notes added.'
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
    const photoSrc = record.photoDataUrl || record.photoUrl || '';
    const hasSiteDistance = record.type === 'attendance' && record.distanceFromSiteM != null;
    extra.innerHTML = `
      <p><strong>Type:</strong> ${record.type === 'attendance' ? escapeHtml(record.action === 'check_in' ? 'Check in' : 'Check out') : 'Task log'}</p>
      ${record.type === 'attendance' && record.location ? `<p><strong>Location:</strong> ${record.location.latitude}, ${record.location.longitude} (${record.location.accuracy}m)</p>` : ''}
      ${hasSiteDistance ? `<p><strong>Site radius:</strong> <span class="${record.withinSiteRadius ? 'site-inside' : 'site-outside'}">${record.withinSiteRadius ? 'Inside' : 'Outside'} - ${escapeHtml(record.distanceFromSiteM)}m from site</span></p>` : ''}
      ${record.hoursWorked ? `<p><strong>Hours:</strong> ${escapeHtml(record.hoursWorked)}</p>` : ''}
      ${record.syncStatus ? `<p><strong>Sync:</strong> ${escapeHtml(record.syncStatus)}</p>` : ''}
      ${photoSrc ? `<img src="${escapeHtml(photoSrc)}" alt="Record photo" />` : ''}
    `;

    const actions = node.querySelector('.record-actions');
    if (showActions) {
      actions.classList.remove('hidden');
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

function activateTab(targetId) {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tabTarget === targetId);
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.id === targetId;
    panel.classList.toggle('active', active);
    panel.classList.toggle('hidden', !active);
  });
}

async function syncQueueIfPossible(showMessage) {
  const result = await flushQueueWith(async (record) => {
    if (record.type === 'attendance') {
      await uploadRecordPhoto(record);
      return await createBackendAttendance(toBackendAttendancePayload(record));
    }

    if (record.type === 'task') {
      await uploadRecordPhoto(record);
      return await createBackendTaskLog(toBackendTaskLogPayload(record));
    }

    throw new Error('Unsupported queued record type.');
  });

  if (showMessage && result.flushed) {
    renderStatusBanner(`${result.flushed} queued record${result.flushed === 1 ? '' : 's'} synced.`);
  }

  if (showMessage && result.failed) {
    renderStatusBanner(`${result.failed} queued record${result.failed === 1 ? '' : 's'} could not sync yet.`, true);
  }
}

async function handleInstall() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  els.installButton.classList.add('hidden');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}

init().catch((error) => {
  console.error(error);
  renderStatusBanner('The app could not start correctly. Check the browser console for details.');
});
