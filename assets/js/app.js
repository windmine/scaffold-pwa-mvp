import {
  initializeMockData,
  login,
  getSession,
  clearSession,
  getSites,
  saveDraft,
  getDraft,
  clearDraft,
  createAttendanceRecord,
  createTaskLog,
  flushQueue,
  getWorkerRecords,
  getPendingApprovals,
  decideRecord,
  getLastSyncAt
} from './mock-api.js';
import { fileToDataUrl, formatDateTime, todayDateInput, uuid, escapeHtml } from './utils.js';

const state = {
  user: null,
  sites: [],
  installPrompt: null,
  attendanceLocation: null,
  attendancePhotoDataUrl: '',
  taskPhotoDataUrl: ''
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
  attendanceSite: document.getElementById('attendanceSite'),
  attendanceNotes: document.getElementById('attendanceNotes'),
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
  refreshSupervisorButton: document.getElementById('refreshSupervisorButton'),
  recordTemplate: document.getElementById('recordTemplate')
};

async function init() {
  await initializeMockData();
  state.sites = await getSites();
  fillSiteSelects();
  state.user = getSession();
  els.taskDate.value = todayDateInput();
  await restoreDrafts();
  bindEvents();
  await syncQueueIfPossible(false);
  renderApp();
  registerServiceWorker();
}

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
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
  els.refreshSupervisorButton.addEventListener('click', renderSupervisorPanel);
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

async function restoreDrafts() {
  const attendanceDraft = await getDraft('attendance-form');
  if (attendanceDraft) {
    els.attendanceSite.value = attendanceDraft.siteId || '';
    els.attendanceNotes.value = attendanceDraft.notes || '';
    state.attendanceLocation = attendanceDraft.location || null;
    state.attendancePhotoDataUrl = attendanceDraft.photoDataUrl || '';
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
    state.user = await login(els.emailInput.value.trim(), els.passwordInput.value);
    renderApp();
  } catch (error) {
    renderStatusBanner(error.message, false);
  }
}

function handleLogout() {
  clearSession();
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
  state.attendancePhotoDataUrl = file ? await fileToDataUrl(file) : '';
  renderPhotoPreview(els.attendancePhotoPreview, state.attendancePhotoDataUrl, 'Attendance photo');
  await persistAttendanceDraft();
}

async function handleTaskPhotoChange(event) {
  const file = event.target.files?.[0];
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

  const site = state.sites.find((item) => item.id === els.attendanceSite.value);
  await createAttendanceRecord({
    id: uuid(),
    userId: state.user.id,
    userName: state.user.fullName,
    siteId: site.id,
    siteName: site.name,
    action,
    notes: els.attendanceNotes.value.trim(),
    photoDataUrl: state.attendancePhotoDataUrl,
    location: state.attendanceLocation,
    createdAt: new Date().toISOString()
  });

  await clearDraft('attendance-form');
  resetAttendanceForm();
  await syncQueueIfPossible(true);
  renderStatusBanner(
    navigator.onLine
      ? `${action === 'check_in' ? 'Check in' : 'Check out'} saved locally and marked ready for supervisor review.`
      : `${action === 'check_in' ? 'Check in' : 'Check out'} saved offline and queued for later sync.`,
    !navigator.onLine
  );
  renderWorkerSummary();
  renderHistory();
}

function resetAttendanceForm() {
  els.attendanceSite.value = '';
  els.attendanceNotes.value = '';
  els.attendancePhoto.value = '';
  state.attendancePhotoDataUrl = '';
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

  const site = state.sites.find((item) => item.id === els.taskSite.value);
  await createTaskLog({
    id: uuid(),
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
  });

  await clearDraft('task-form');
  resetTaskForm();
  await syncQueueIfPossible(true);
  renderStatusBanner(
    navigator.onLine
      ? 'Task log saved locally and marked ready for supervisor review.'
      : 'Task log saved offline and queued for later sync.',
    !navigator.onLine
  );
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
  renderPhotoPreview(els.taskPhotoPreview, '', '');
}

async function renderWorkerSummary() {
  if (!state.user) return;
  const records = await getWorkerRecords(state.user.id);
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = records.filter((record) => record.createdAt.slice(0, 10) === today || record.workDate === today);
  const queuedCount = records.filter((record) => record.syncStatus === 'queued').length;

  els.workerSummary.innerHTML = `
    <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
    <div class="summary-item"><span>Entries today</span><strong>${todayRecords.length}</strong></div>
    <div class="summary-item"><span>Queued offline</span><strong>${queuedCount}</strong></div>
  `;
}

async function renderHistory() {
  if (!state.user) return;
  const records = await getWorkerRecords(state.user.id);
  renderRecordsList(els.historyList, records, false);
}

async function renderSupervisorPanel() {
  const pending = await getPendingApprovals();
  els.supervisorSummary.innerHTML = `
    <div class="summary-item"><span>Signed in as</span><strong>${escapeHtml(state.user.fullName)}</strong></div>
    <div class="summary-item"><span>Pending approvals</span><strong>${pending.length}</strong></div>
  `;
  renderRecordsList(els.pendingApprovalsList, pending, true);
}

function renderRecordsList(container, records, showActions) {
  container.innerHTML = '';
  if (!records.length) {
    container.innerHTML = '<div class="empty-state">No records found yet.</div>';
    return;
  }

  records.forEach((record) => {
    const node = els.recordTemplate.content.firstElementChild.cloneNode(true);
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
    const badgeText = `${record.status}  |  ${record.syncStatus}`;
    badge.textContent = badgeText;
    badge.className = `badge ${record.status} ${record.syncStatus}`;

    const extra = node.querySelector('.record-extra');
    extra.innerHTML = `
      ${record.type === 'attendance' && record.location ? `<p><strong>Location:</strong> ${record.location.latitude}, ${record.location.longitude} (${record.location.accuracy}m)</p>` : ''}
      ${record.hoursWorked ? `<p><strong>Hours:</strong> ${escapeHtml(record.hoursWorked)}</p>` : ''}
      ${record.photoDataUrl ? `<img src="${record.photoDataUrl}" alt="Record photo" />` : ''}
    `;

    const actions = node.querySelector('.record-actions');
    if (showActions) {
      actions.classList.remove('hidden');
      const approveButton = document.createElement('button');
      approveButton.type = 'button';
      approveButton.textContent = 'Approve';
      approveButton.addEventListener('click', async () => {
        await decideRecord(record.id, 'approved');
        renderSupervisorPanel();
        if (state.user?.role === 'worker') renderHistory();
      });

      const rejectButton = document.createElement('button');
      rejectButton.type = 'button';
      rejectButton.textContent = 'Reject';
      rejectButton.className = 'secondary';
      rejectButton.addEventListener('click', async () => {
        await decideRecord(record.id, 'rejected');
        renderSupervisorPanel();
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
  const result = await flushQueue();
  if (showMessage && result.flushed) {
    renderStatusBanner(`${result.flushed} queued record${result.flushed === 1 ? '' : 's'} synced locally.`);
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
