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
  updateUserStatus as updateBackendUserStatus,
  getSites as getBackendSites,
  createSite as createBackendSite,
  updateSite as updateBackendSite,
  uploadPhoto,
  createAttendance as createBackendAttendance,
  getMyRecords as getBackendMyAttendanceRecords,
  updateMyRecord as updateBackendMyRecord,
  deleteMyRecord as deleteBackendMyRecord,
  createTaskLog as createBackendTaskLog,
  getMyTaskLogs as getBackendMyTaskLogs,
  getTaskTemplates as getBackendTaskTemplates,
  createTaskTemplate as createBackendTaskTemplate,
  deleteTaskTemplate as deleteBackendTaskTemplate,
  getSupervisorRecords as getBackendSupervisorRecords,
  exportSupervisorRecordsCsv,
  getSupervisorTaskLogs as getBackendSupervisorTaskLogs,
  decideRecord as decideBackendRecord,
  updateSupervisorRecord as updateBackendSupervisorRecord,
  updateSupervisorTaskLog as updateBackendSupervisorTaskLog,
  logout as clearBackendSession
} from './api-client.js';
import { dataUrlToBlob, dateInputValue, fileToDataUrl, formatDateTime, todayDateInput, uuid, escapeHtml } from './utils.js';

const MAX_TASK_LOG_PHOTOS = 8;

const state = {
  user: null,
  sites: [],
  installPrompt: null,
  attendanceLocation: null,
  attendancePhotoDataUrl: '',
  attendancePhotoFile: null,
  taskPhotoFiles: [],
  taskPhotoDataUrls: [],
  taskTemplates: [],
  historyRecords: [],
  staffUsers: [],
  photoViewer: {
    sources: [],
    index: 0,
    title: ''
  },
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
  taskTemplateSelect: document.getElementById('taskTemplateSelect'),
  taskTemplateNameInput: document.getElementById('taskTemplateNameInput'),
  applyTaskTemplateButton: document.getElementById('applyTaskTemplateButton'),
  saveTaskTemplateButton: document.getElementById('saveTaskTemplateButton'),
  deleteTaskTemplateButton: document.getElementById('deleteTaskTemplateButton'),
  workerEditPanel: document.getElementById('workerEditPanel'),
  workerEditPanelTitle: document.getElementById('workerEditPanelTitle'),
  workerEditPanelForm: document.getElementById('workerEditPanelForm'),
  cancelWorkerEditButton: document.getElementById('cancelWorkerEditButton'),
  supervisorSummary: document.getElementById('supervisorSummary'),
  pendingApprovalsList: document.getElementById('pendingApprovalsList'),
  reviewedApprovalsList: document.getElementById('reviewedApprovalsList'),
  supervisorTaskLogsList: document.getElementById('supervisorTaskLogsList'),
  supervisorEditPanel: document.getElementById('supervisorEditPanel'),
  editPanelTitle: document.getElementById('editPanelTitle'),
  editPanelForm: document.getElementById('editPanelForm'),
  cancelEditButton: document.getElementById('cancelEditButton'),
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
  siteSearchInput: document.getElementById('siteSearchInput'),
  supervisorSitesList: document.getElementById('supervisorSitesList'),
  staffSearchInput: document.getElementById('staffSearchInput'),
  refreshSupervisorButton: document.getElementById('refreshSupervisorButton'),
  photoViewer: document.getElementById('photoViewer'),
  photoViewerImage: document.getElementById('photoViewerImage'),
  photoViewerCaption: document.getElementById('photoViewerCaption'),
  closePhotoViewerButton: document.getElementById('closePhotoViewerButton'),
  previousPhotoButton: document.getElementById('previousPhotoButton'),
  nextPhotoButton: document.getElementById('nextPhotoButton'),
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
  els.applyTaskTemplateButton.addEventListener('click', applySelectedTaskTemplate);
  els.saveTaskTemplateButton.addEventListener('click', saveCurrentTaskTemplate);
  els.deleteTaskTemplateButton.addEventListener('click', deleteSelectedTaskTemplate);
  els.cancelWorkerEditButton.addEventListener('click', () => closeEditPanel('worker'));
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
  els.siteSearchInput.addEventListener('input', renderSupervisorSites);
  els.staffSearchInput.addEventListener('input', renderFilteredStaffUsers);
  els.cancelEditButton.addEventListener('click', closeEditPanel);
  els.closePhotoViewerButton.addEventListener('click', closePhotoViewer);
  els.previousPhotoButton.addEventListener('click', () => stepPhotoViewer(-1));
  els.nextPhotoButton.addEventListener('click', () => stepPhotoViewer(1));
  els.photoViewer.addEventListener('click', (event) => {
    if (event.target.matches('[data-photo-viewer-close]')) {
      closePhotoViewer();
    }
  });
  document.addEventListener('keydown', handlePhotoViewerKeydown);
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
    state.taskPhotoDataUrls = taskDraft.photoDataUrls || (taskDraft.photoDataUrl ? [taskDraft.photoDataUrl] : []);
    renderPhotoPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Task draft photo');
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
    refreshTaskTemplates();
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
  const selectedFiles = Array.from(event.target.files || []);
  const files = selectedFiles.slice(0, MAX_TASK_LOG_PHOTOS);
  state.taskPhotoFiles = files;
  state.taskPhotoDataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
  renderPhotoPreviews(els.taskPhotoPreview, state.taskPhotoDataUrls, 'Task photo');
  await persistTaskDraft();
  if (selectedFiles.length > MAX_TASK_LOG_PHOTOS) {
    renderStatusBanner(`Task logs can include up to ${MAX_TASK_LOG_PHOTOS} photos. The first ${MAX_TASK_LOG_PHOTOS} were kept.`, true);
  }
}

function renderPhotoPreview(container, dataUrl, alt) {
  renderPhotoPreviews(container, dataUrl ? [dataUrl] : [], alt);
}

function renderPhotoPreviews(container, dataUrls, alt) {
  const urls = Array.isArray(dataUrls) ? dataUrls.filter(Boolean) : [];
  if (!urls.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = urls
    .map((dataUrl, index) => `
      <button class="photo-thumb" type="button" data-photo-index="${index}">
        <img src="${dataUrl}" alt="${escapeHtml(`${alt} ${index + 1}`)}" />
      </button>
    `)
    .join('');
  container.querySelectorAll('.photo-thumb').forEach((button) => {
    button.addEventListener('click', () => {
      openPhotoViewer(urls, Number(button.dataset.photoIndex || 0), alt);
    });
  });
}

function openPhotoViewer(sources, index = 0, title = 'Photo') {
  const cleanSources = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!cleanSources.length) return;

  state.photoViewer = {
    sources: cleanSources,
    index: Math.min(Math.max(index, 0), cleanSources.length - 1),
    title
  };
  renderPhotoViewer();
  els.photoViewer.classList.remove('hidden');
  document.body.classList.add('viewer-open');
  els.closePhotoViewerButton.focus();
}

function closePhotoViewer() {
  els.photoViewer.classList.add('hidden');
  document.body.classList.remove('viewer-open');
  els.photoViewerImage.src = '';
}

function renderPhotoViewer() {
  const { sources, index, title } = state.photoViewer;
  const count = sources.length;

  els.photoViewerImage.src = sources[index] || '';
  els.photoViewerImage.alt = `${title} ${index + 1}`;
  els.photoViewerCaption.textContent = count > 1
    ? `${title} ${index + 1} of ${count}`
    : title;
  els.previousPhotoButton.disabled = count < 2;
  els.nextPhotoButton.disabled = count < 2;
}

function stepPhotoViewer(direction) {
  const count = state.photoViewer.sources.length;
  if (count < 2) return;

  state.photoViewer.index = (state.photoViewer.index + direction + count) % count;
  renderPhotoViewer();
}

function handlePhotoViewerKeydown(event) {
  if (els.photoViewer.classList.contains('hidden')) return;

  if (event.key === 'Escape') {
    closePhotoViewer();
  } else if (event.key === 'ArrowLeft') {
    stepPhotoViewer(-1);
  } else if (event.key === 'ArrowRight') {
    stepPhotoViewer(1);
  }
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
    photoDataUrl: state.taskPhotoDataUrls[0] || '',
    photoDataUrls: state.taskPhotoDataUrls
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
  const photoUrls = normaliseRecordPhotoUrls(record);

  return {
    description: record.summary,
    site_id: getBackendSiteId(record.siteId),
    work_date: record.workDate || null,
    hours_worked: record.hoursWorked ? Number(record.hoursWorked) : null,
    safety_notes: record.safetyNotes || null,
    photo_url: photoUrls[0] || null,
    photo_urls: photoUrls
  };
}

function normaliseRecordPhotoUrls(record) {
  const urls = Array.isArray(record.photoUrls) ? [...record.photoUrls] : [];
  if (record.photoUrl && !urls.includes(record.photoUrl)) {
    urls.unshift(record.photoUrl);
  }
  return urls.filter(Boolean);
}

function photoFilenameFor(record, file, index = 0, dataUrl = '') {
  if (file?.name) return file.name;
  const extension = (dataUrl || record.photoDataUrl || '').match(/^data:image\/([a-z0-9+.-]+);base64,/i)?.[1] || 'jpg';
  const suffix = index ? `-${index + 1}` : '';
  return `${record.type || 'record'}-${record.id || uuid()}${suffix}.${extension.replace('jpeg', 'jpg')}`;
}

async function uploadRecordPhotos(record, files = []) {
  const existingUrls = normaliseRecordPhotoUrls(record);
  if (existingUrls.length) {
    record.photoUrls = existingUrls;
    record.photoUrl = existingUrls[0];
    return existingUrls;
  }

  const fileList = Array.from(files || []);
  const dataUrls = Array.isArray(record.photoDataUrls)
    ? record.photoDataUrls.filter(Boolean)
    : (record.photoDataUrl ? [record.photoDataUrl] : []);

  const sources = fileList.length
    ? fileList.map((file, index) => ({
      source: file,
      file,
      dataUrl: dataUrls[index] || ''
    }))
    : dataUrls.map((dataUrl) => ({
      source: dataUrlToBlob(dataUrl),
      file: null,
      dataUrl
    }));

  if (!sources.length) return [];

  const uploadedUrls = [];
  for (const [index, item] of sources.entries()) {
    const uploaded = await uploadPhoto(item.source, photoFilenameFor(record, item.file, index, item.dataUrl));
    uploadedUrls.push(uploaded.url);
  }

  record.photoUrls = uploadedUrls;
  record.photoUrl = uploadedUrls[0] || '';
  return uploadedUrls;
}

async function uploadRecordPhoto(record, file = null) {
  const urls = await uploadRecordPhotos(record, file ? [file] : []);
  return urls[0] || null;
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
    photoDataUrl: state.taskPhotoDataUrls[0] || '',
    photoDataUrls: state.taskPhotoDataUrls,
    photoUrls: [],
    createdAt: new Date().toISOString()
  };

  let successMessage = 'Task log saved offline and queued for later sync.';
  let offlineStatus = true;

  if (navigator.onLine) {
    try {
      await uploadRecordPhotos(localRecord, state.taskPhotoFiles);
      const backendLog = await createBackendTaskLog(toBackendTaskLogPayload(localRecord));
      localRecord.syncStatus = 'synced';
      localRecord.backendRecordId = backendLog.id;
      localRecord.status = backendLog.status || 'logged';
      localRecord.photoUrls = backendLog.photo_urls || localRecord.photoUrls;
      localRecord.photoUrl = backendLog.photo_url || localRecord.photoUrl;
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
  state.taskPhotoDataUrls = [];
  state.taskPhotoFiles = [];
  renderPhotoPreviews(els.taskPhotoPreview, [], 'Task photo');
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
  await persistTaskDraft();
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
  renderRecordsList(els.pendingApprovalsList, filteredPending, {
    showDecisionActions: true,
    showEditActions: true
  });
  renderRecordsList(els.reviewedApprovalsList, filteredReviewed, {
    showEditActions: true
  });
  renderRecordsList(els.supervisorTaskLogsList, filteredTaskLogs, {
    showEditActions: true
  });
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
  const query = els.siteSearchInput.value.trim().toLowerCase();
  const sites = state.sites.filter((site) => {
    const text = [
      site.id,
      site.name,
      site.address,
      site.latitude,
      site.longitude,
      site.allowed_radius_m || site.allowedRadiusM
    ].join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  els.supervisorSitesCount.textContent = query ? `${sites.length}/${state.sites.length}` : String(state.sites.length);

  if (!sites.length) {
    els.supervisorSitesList.innerHTML = '<div class="empty-state">No sites found yet.</div>';
    return;
  }

  sites.forEach((site) => {
    const node = document.createElement('article');
    node.className = 'record-card';
    node.innerHTML = `
      <div class="record-header">
        <div>
          <h3 class="record-title">${escapeHtml(site.name)}</h3>
          <p class="record-meta">ID ${escapeHtml(site.id)} | ${escapeHtml(site.address || 'No address added')}</p>
        </div>
        <span class="badge synced">${escapeHtml(site.allowed_radius_m || site.allowedRadiusM || 100)}m</span>
      </div>
      <p class="record-detail">Lat ${escapeHtml(site.latitude ?? '-')}, Lng ${escapeHtml(site.longitude ?? '-')}</p>
      <div class="record-actions"></div>
    `;
    const actions = node.querySelector('.record-actions');
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'ghost';
    editButton.textContent = 'Edit site';
    editButton.addEventListener('click', async () => {
      await handleSiteEdit(site);
    });
    actions.append(editButton);
    els.supervisorSitesList.appendChild(node);
  });
}

async function renderStaffUsers() {
  try {
    state.staffUsers = await getBackendUsers();
    renderFilteredStaffUsers();
  } catch (error) {
    els.staffUsersCount.textContent = '-';
    els.staffUsersList.innerHTML = '<div class="empty-state">Staff users are unavailable.</div>';
    renderStatusBanner(error.message || 'Could not load staff users.', true);
  }
}

function renderFilteredStaffUsers() {
  const query = els.staffSearchInput.value.trim().toLowerCase();
  const users = state.staffUsers.filter((user) => {
    const text = [
      user.id,
      user.name,
      user.email,
      user.role,
      user.status || 'active'
    ].join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  els.staffUsersList.innerHTML = '';
  els.staffUsersCount.textContent = query ? `${users.length}/${state.staffUsers.length}` : String(state.staffUsers.length);

  if (!users.length) {
    els.staffUsersList.innerHTML = '<div class="empty-state">No users found yet.</div>';
    return;
  }

  users.forEach((user) => {
    const node = document.createElement('article');
    node.className = 'record-card';
    const status = user.status || 'active';
    node.innerHTML = `
      <div class="record-header">
        <div>
          <h3 class="record-title">${escapeHtml(user.name)}</h3>
          <p class="record-meta">ID ${escapeHtml(user.id)} | ${escapeHtml(user.email)}</p>
        </div>
        <span class="badge ${status === 'active' ? 'synced' : 'rejected'}">${escapeHtml(status === 'active' ? user.role : 'resigned worker')}</span>
      </div>
      <div class="record-actions"></div>
    `;
    const actions = node.querySelector('.record-actions');
    const statusButton = document.createElement('button');
    statusButton.type = 'button';
    statusButton.className = status === 'active' ? 'secondary' : '';
    statusButton.textContent = status === 'active' ? 'Mark resigned' : 'Reactivate';
    statusButton.addEventListener('click', async () => {
      await handleUserStatusChange(user, status === 'active' ? 'resigned' : 'active');
    });
    actions.append(statusButton);
    els.staffUsersList.appendChild(node);
  });
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

async function handleUserStatusChange(user, status) {
  const label = status === 'resigned' ? 'mark this worker resigned' : 'reactivate this worker';
  if (!window.confirm(`Double check: ${label}? Their previous records will stay attached to this account.`)) return;

  try {
    await updateBackendUserStatus(user.id, status);
    renderStatusBanner(status === 'resigned' ? 'Worker marked resigned.' : 'Worker reactivated.');
    await renderStaffUsers();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not update worker status.', true);
  }
}

function getEditPanel(scope = 'supervisor') {
  if (scope === 'worker') {
    return {
      panel: els.workerEditPanel,
      title: els.workerEditPanelTitle,
      form: els.workerEditPanelForm
    };
  }

  return {
    panel: els.supervisorEditPanel,
    title: els.editPanelTitle,
    form: els.editPanelForm
  };
}

function closeEditPanel(scope = 'supervisor') {
  const target = getEditPanel(scope);
  target.panel.classList.add('hidden');
  target.form.innerHTML = '';
}

function showEditPanel(title, fields, submitLabel, onSubmit, scope = 'supervisor') {
  const target = getEditPanel(scope);
  target.title.textContent = title;
  target.form.innerHTML = fields.map((field) => {
    if (field.type === 'select') {
      return `
        <label>
          ${escapeHtml(field.label)}
          <select id="${field.id}">
            ${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(field.value) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
          </select>
        </label>
      `;
    }

    if (field.type === 'textarea') {
      return `
        <label>
          ${escapeHtml(field.label)}
          <textarea id="${field.id}" rows="${field.rows || 3}">${escapeHtml(field.value || '')}</textarea>
        </label>
      `;
    }

    return `
      <label>
        ${escapeHtml(field.label)}
        <input id="${field.id}" type="${field.type || 'text'}" value="${escapeHtml(field.value ?? '')}" ${field.step ? `step="${escapeHtml(field.step)}"` : ''} ${field.min != null ? `min="${escapeHtml(field.min)}"` : ''} ${field.max != null ? `max="${escapeHtml(field.max)}"` : ''} />
      </label>
    `;
  }).join('') + `
    <div class="edit-warning">Double check before saving. This changes backend records.</div>
    <div class="split-actions">
      <button type="submit">${escapeHtml(submitLabel)}</button>
      <button id="${scope}SecondaryCancelEditButton" type="button" class="ghost">Cancel</button>
    </div>
  `;
  target.panel.classList.remove('hidden');
  target.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  target.form.onsubmit = async (event) => {
    event.preventDefault();
    await onSubmit();
  };
  document.getElementById(`${scope}SecondaryCancelEditButton`).addEventListener('click', () => closeEditPanel(scope));
}

function editValue(id) {
  return document.getElementById(id).value.trim();
}

function editNumber(id) {
  const value = editValue(id);
  return value === '' ? null : Number(value);
}

function siteSelectOptions() {
  return [
    { value: '', label: 'No site' },
    ...state.sites.map((site) => ({
      value: site.id,
      label: `${site.name} (#${site.id})`
    }))
  ];
}

async function handleSiteEdit(site) {
  showEditPanel(
    `Edit site: ${site.name}`,
    [
      { id: 'editSiteName', label: 'Site name', value: site.name },
      { id: 'editSiteAddress', label: 'Address', value: site.address || '' },
      { id: 'editSiteLatitude', label: 'Latitude', type: 'number', step: '0.000001', min: -90, max: 90, value: site.latitude },
      { id: 'editSiteLongitude', label: 'Longitude', type: 'number', step: '0.000001', min: -180, max: 180, value: site.longitude },
      { id: 'editSiteRadius', label: 'Allowed radius metres', type: 'number', min: 10, max: 5000, value: site.allowed_radius_m || site.allowedRadiusM || 100 }
    ],
    'Save site',
    async () => {
      if (!window.confirm(`Double check: save changes to site "${site.name}"?`)) return;
      try {
        await updateBackendSite(site.id, {
          name: editValue('editSiteName'),
          address: editValue('editSiteAddress') || null,
          latitude: editNumber('editSiteLatitude'),
          longitude: editNumber('editSiteLongitude'),
          allowed_radius_m: editNumber('editSiteRadius')
        });
        closeEditPanel();
        state.sites = await loadSites();
        fillSiteSelects();
        renderSupervisorSites();
        renderStatusBanner('Site updated.');
      } catch (error) {
        renderStatusBanner(error.message || 'Could not update site.', true);
      }
    }
  );
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

function canWorkerEditRecord(record) {
  if (!record.backendRecordId) return false;
  return record.type === 'attendance' && record.status === 'pending';
}

async function handleWorkerEditRecord(record) {
  if (!canWorkerEditRecord(record)) {
    renderStatusBanner('This record cannot be edited here.', true);
    return;
  }

  showEditPanel(
    `Edit pending attendance: ${record.siteName}`,
    [
      {
        id: 'workerEditAttendanceType',
        label: 'Type',
        type: 'select',
        value: record.action || 'check_in',
        options: [
          { value: 'check_in', label: 'Check in' },
          { value: 'check_out', label: 'Check out' }
        ]
      },
      { id: 'workerEditAttendanceSiteId', label: 'Site', type: 'select', value: record.siteId || '', options: siteSelectOptions() },
      { id: 'workerEditAttendanceLatitude', label: 'Latitude', type: 'number', step: '0.000001', min: -90, max: 90, value: record.location?.latitude || '' },
      { id: 'workerEditAttendanceLongitude', label: 'Longitude', type: 'number', step: '0.000001', min: -180, max: 180, value: record.location?.longitude || '' },
      { id: 'workerEditAttendanceAccuracy', label: 'Accuracy metres', type: 'number', min: 0, value: record.location?.accuracy || '' },
      { id: 'workerEditAttendanceNote', label: 'Notes', type: 'textarea', rows: 4, value: record.notes || '' }
    ],
    'Save attendance',
    async () => {
      if (!window.confirm('Save changes to this pending check-in/check-out?')) return;
      try {
        await updateBackendMyRecord(record.backendRecordId, {
          record_type: editValue('workerEditAttendanceType'),
          site_id: editNumber('workerEditAttendanceSiteId'),
          latitude: editNumber('workerEditAttendanceLatitude'),
          longitude: editNumber('workerEditAttendanceLongitude'),
          accuracy: editNumber('workerEditAttendanceAccuracy'),
          note: editValue('workerEditAttendanceNote') || null
        });
        closeEditPanel('worker');
        renderStatusBanner('Pending attendance updated.');
        await renderHistory();
        await renderWorkerSummary();
      } catch (error) {
        renderStatusBanner(error.message || 'Could not update attendance.', true);
      }
    },
    'worker'
  );
}

async function handleWorkerDeleteRecord(record) {
  if (!canWorkerEditRecord(record)) {
    renderStatusBanner('This record cannot be deleted here.', true);
    return;
  }

  if (!window.confirm('Delete this pending check-in/check-out?')) return;

  try {
    await deleteBackendMyRecord(record.backendRecordId);
    renderStatusBanner('Attendance deleted.');
    await renderHistory();
    await renderWorkerSummary();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not delete record.', true);
  }
}

async function handleSupervisorEditRecord(record) {
  if (!record.backendRecordId) {
    renderStatusBanner('Only backend records can be adjusted by a supervisor.', true);
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
          await renderSupervisorPanel();
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
        await renderSupervisorPanel();
      } catch (error) {
        renderStatusBanner(error.message || 'Could not update attendance record.', true);
      }
    }
  );
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
    const photoSources = (Array.isArray(record.photoDataUrls) && record.photoDataUrls.length)
      ? record.photoDataUrls
      : (normaliseRecordPhotoUrls(record).length ? normaliseRecordPhotoUrls(record) : (record.photoDataUrl ? [record.photoDataUrl] : []));
    const hasSiteDistance = record.type === 'attendance' && record.distanceFromSiteM != null;
    extra.innerHTML = `
      <p><strong>Type:</strong> ${record.type === 'attendance' ? escapeHtml(record.action === 'check_in' ? 'Check in' : 'Check out') : 'Task log'}</p>
      ${record.type === 'attendance' && record.location ? `<p><strong>Location:</strong> ${record.location.latitude}, ${record.location.longitude} (${record.location.accuracy}m)</p>` : ''}
      ${hasSiteDistance ? `<p><strong>Site radius:</strong> <span class="${record.withinSiteRadius ? 'site-inside' : 'site-outside'}">${record.withinSiteRadius ? 'Inside' : 'Outside'} - ${escapeHtml(record.distanceFromSiteM)}m from site</span></p>` : ''}
      ${record.hoursWorked ? `<p><strong>Hours:</strong> ${escapeHtml(record.hoursWorked)}</p>` : ''}
      ${record.syncStatus ? `<p><strong>Sync:</strong> ${escapeHtml(record.syncStatus)}</p>` : ''}
      ${photoSources.length ? `<div class="record-photos">${photoSources.map((photoSrc, index) => `
        <button class="photo-thumb" type="button" data-photo-index="${index}">
          <img src="${escapeHtml(photoSrc)}" alt="Record photo ${index + 1}" />
        </button>
      `).join('')}</div>` : ''}
    `;
    extra.querySelectorAll('.photo-thumb').forEach((button) => {
      button.addEventListener('click', () => {
        openPhotoViewer(photoSources, Number(button.dataset.photoIndex || 0), title);
      });
    });

    const actions = node.querySelector('.record-actions');
    if (showDecisionActions || showEditActions || showWorkerActions) {
      actions.classList.remove('hidden');
    }

    if (showWorkerActions && canWorkerEditRecord(record)) {
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

    if (showEditActions) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost';
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', async () => {
        await handleSupervisorEditRecord(record);
      });
      actions.append(editButton);
    }

    if (showDecisionActions) {
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
      await uploadRecordPhotos(record);
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
