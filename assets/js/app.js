import {
  initializeMockData,
  getSites as getLocalSites,
  getDraft,
  getLastSyncAt
} from './mock-api.js';
import {
  login as backendLogin,
  register as backendRegister,
  getSession as getBackendSession,
  getCurrentUser,
  getSites as getBackendSites,
  updateMyRecord as updateBackendMyRecord,
  deleteMyRecord as deleteBackendMyRecord,
  logout as clearBackendSession
} from './api-client.js';
import { syncQueuedSubmissions } from './offline-submissions.js';
import { createHistoryModule } from './history.js';
import { createPhotoViewer } from './photo-viewer.js';
import { createStaffSitesModule } from './staff-sites.js';
import { createSupervisorReviewModule } from './supervisor-review.js';
import { createWorkerAttendanceModule } from './worker-attendance.js';
import { createWorkerFormModule } from './worker-form.js';
import { createWorkerLogModule } from './worker-log.js';
import { createWorkerSitesModule } from './worker-sites.js';
import { formatDateTime, todayDateInput, escapeHtml } from './utils.js';

const MAX_TASK_LOG_PHOTOS = 8;
const THEME_STORAGE_KEY = 'leader-theme';
const THEME_COLORS = {
  dark: '#000000',
  light: '#f4f7fb'
};

const state = {
  user: null,
  sites: [],
  installPrompt: null,
  waitingServiceWorker: null,
  attendanceLocation: null,
  attendancePhotoDataUrl: '',
  attendancePhotoFile: null,
  taskPhotoFiles: [],
  taskPhotoDataUrls: [],
  taskPhotoMetadata: [],
  dayworkLogDraft: null,
  dayworkFormId: null,
  workForms: [],
  workFormPhotoFiles: [],
  workFormPhotoDataUrls: [],
  workFormPhotoMetadata: [],
  submittingAttendance: false,
  submittingTask: false,
  submittingWorkForm: false,
  submittingWorkerSite: false,
  historyRecords: [],
  staffUsers: [],
  supervisorRecords: {
    reviewRecords: [],
    auditEvents: []
  }
};

const els = {
  statusBanner: document.getElementById('statusBanner'),
  installButton: document.getElementById('installButton'),
  themeToggleButton: document.getElementById('themeToggleButton'),
  downloadAppButton: document.getElementById('downloadAppButton'),
  downloadAppHelp: document.getElementById('downloadAppHelp'),
  updateButton: document.getElementById('updateButton'),
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
  dayworkFormHint: document.getElementById('dayworkFormHint'),
  dayworkFormFields: document.getElementById('dayworkFormFields'),
  taskPhoto: document.getElementById('taskPhoto'),
  taskPhotoPreview: document.getElementById('taskPhotoPreview'),
  saveTaskDraftButton: document.getElementById('saveTaskDraftButton'),
  submitTaskButton: document.getElementById('submitTaskButton'),
  workerSiteForm: document.getElementById('workerSiteForm'),
  workerSiteNameInput: document.getElementById('workerSiteNameInput'),
  workerSiteAddressInput: document.getElementById('workerSiteAddressInput'),
  workerSiteLatitudeInput: document.getElementById('workerSiteLatitudeInput'),
  workerSiteLongitudeInput: document.getElementById('workerSiteLongitudeInput'),
  workerSiteRadiusInput: document.getElementById('workerSiteRadiusInput'),
  workerSiteUseLocationButton: document.getElementById('workerSiteUseLocationButton'),
  workerSiteSubmitButton: document.getElementById('workerSiteSubmitButton'),
  workFormSubmissionForm: document.getElementById('workFormSubmissionForm'),
  workFormSelect: document.getElementById('workFormSelect'),
  workFormSite: document.getElementById('workFormSite'),
  workFormDate: document.getElementById('workFormDate'),
  workFormFields: document.getElementById('workFormFields'),
  workFormPhotos: document.getElementById('workFormPhotos'),
  workFormPhotoPreview: document.getElementById('workFormPhotoPreview'),
  submitWorkFormButton: document.getElementById('submitWorkFormButton'),
  workerEditPanel: document.getElementById('workerEditPanel'),
  workerEditPanelTitle: document.getElementById('workerEditPanelTitle'),
  workerEditPanelForm: document.getElementById('workerEditPanelForm'),
  cancelWorkerEditButton: document.getElementById('cancelWorkerEditButton'),
  supervisorSummary: document.getElementById('supervisorSummary'),
  reviewQueueList: document.getElementById('reviewQueueList'),
  supervisorEditPanel: document.getElementById('supervisorEditPanel'),
  editPanelTitle: document.getElementById('editPanelTitle'),
  editPanelForm: document.getElementById('editPanelForm'),
  cancelEditButton: document.getElementById('cancelEditButton'),
  supervisorSearchInput: document.getElementById('supervisorSearchInput'),
  supervisorTypeFilter: document.getElementById('supervisorTypeFilter'),
  supervisorStatusFilter: document.getElementById('supervisorStatusFilter'),
  supervisorDateFilter: document.getElementById('supervisorDateFilter'),
  supervisorResultCount: document.getElementById('supervisorResultCount'),
  auditEventsCount: document.getElementById('auditEventsCount'),
  auditEventsList: document.getElementById('auditEventsList'),
  refreshAuditButton: document.getElementById('refreshAuditButton'),
  workFormsCount: document.getElementById('workFormsCount'),
  supervisorSitesCount: document.getElementById('supervisorSitesCount'),
  staffUsersCount: document.getElementById('staffUsersCount'),
  clearSupervisorFiltersButton: document.getElementById('clearSupervisorFiltersButton'),
  exportAttendanceButton: document.getElementById('exportAttendanceButton'),
  exportTaskLogsButton: document.getElementById('exportTaskLogsButton'),
  exportDocumentSelect: document.getElementById('exportDocumentSelect'),
  exportDocumentButton: document.getElementById('exportDocumentButton'),
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
  workFormBuilderForm: document.getElementById('workFormBuilderForm'),
  workFormNameInput: document.getElementById('workFormNameInput'),
  workFormDescriptionInput: document.getElementById('workFormDescriptionInput'),
  workFormFieldsInput: document.getElementById('workFormFieldsInput'),
  workFormPreviewButton: document.getElementById('workFormPreviewButton'),
  workFormDraftPreview: document.getElementById('workFormDraftPreview'),
  workFormsList: document.getElementById('workFormsList'),
  refreshSupervisorButton: document.getElementById('refreshSupervisorButton'),
  photoViewer: document.getElementById('photoViewer'),
  photoViewerImage: document.getElementById('photoViewerImage'),
  photoViewerCaption: document.getElementById('photoViewerCaption'),
  closePhotoViewerButton: document.getElementById('closePhotoViewerButton'),
  previousPhotoButton: document.getElementById('previousPhotoButton'),
  nextPhotoButton: document.getElementById('nextPhotoButton'),
  recordTemplate: document.getElementById('recordTemplate')
};

const photoViewer = createPhotoViewer({
  viewer: els.photoViewer,
  image: els.photoViewerImage,
  caption: els.photoViewerCaption,
  closeButton: els.closePhotoViewerButton,
  previousButton: els.previousPhotoButton,
  nextButton: els.nextPhotoButton
});

let staffSitesModule;
let supervisorReviewModule;
let reloadingForServiceWorkerUpdate = false;

const historyModule = createHistoryModule({
  els,
  state,
  photoViewer,
  handleSessionExpired,
  renderStatusBanner,
  canWorkerEditRecord,
  handleWorkerEditRecord,
  handleWorkerDeleteRecord,
  handleSupervisorEditRecord,
  handleSupervisorDecision,
  handleSupervisorExportRecord
});

const workerAttendance = createWorkerAttendanceModule({
  els,
  state,
  photoViewer,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary: historyModule.renderWorkerSummary,
  renderHistory: historyModule.renderHistory,
  handleSessionExpired,
  isBackendSessionError
});

const workerLog = createWorkerLogModule({
  els,
  state,
  photoViewer,
  maxPhotos: MAX_TASK_LOG_PHOTOS,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary: historyModule.renderWorkerSummary,
  renderHistory: historyModule.renderHistory,
  handleSessionExpired,
  isBackendSessionError
});

const workerForm = createWorkerFormModule({
  els,
  state,
  photoViewer,
  maxPhotos: MAX_TASK_LOG_PHOTOS,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary: historyModule.renderWorkerSummary,
  renderHistory: historyModule.renderHistory,
  handleSessionExpired,
  isBackendSessionError,
  onSupervisorWorkFormsChanged: () => staffSitesModule?.renderWorkFormsList(),
  onWorkFormsChanged: () => workerLog.renderDayworkForm()
});

const workerSites = createWorkerSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError
});

staffSitesModule = createStaffSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  refreshWorkForms: () => workerForm.refreshWorkForms(),
  refreshSupervisorAuditHistory: () => supervisorReviewModule?.renderAuditHistory(),
  renderStatusBanner,
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber
});

supervisorReviewModule = createSupervisorReviewModule({
  els,
  state,
  historyModule,
  handleSessionExpired,
  renderStatusBanner,
  refreshWorkForms: () => workerForm.refreshWorkForms(),
  renderSupervisorSites: () => staffSitesModule.renderSupervisorSites(),
  renderStaffUsers: () => staffSitesModule.renderStaffUsers(),
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber,
  siteSelectOptions: () => staffSitesModule.siteSelectOptions()
});

async function init() {
  await initializeMockData();
  state.sites = await loadSites();
  fillSiteSelects();
  const authRestoreMessage = await restoreBackendSession();
  els.taskDate.value = todayDateInput();
  els.workFormDate.value = todayDateInput();
  await restoreDrafts();
  bindEvents();
  renderInstallHelp();
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
  renderThemeToggle();
  els.themeToggleButton.addEventListener('click', handleThemeToggle);
  els.loginForm.addEventListener('submit', handleLogin);
  els.registerForm.addEventListener('submit', handleRegister);
  els.logoutButton.addEventListener('click', handleLogout);
  workerAttendance.bindEvents();
  workerLog.bindEvents();
  workerForm.bindEvents();
  workerSites.bindEvents();
  els.cancelWorkerEditButton.addEventListener('click', () => closeEditPanel('worker'));
  historyModule.bindEvents();
  supervisorReviewModule.bindEvents();
  staffSitesModule.bindEvents();
  els.cancelEditButton.addEventListener('click', closeEditPanel);
  photoViewer.bindEvents();
  els.installButton.addEventListener('click', handleInstall);
  els.downloadAppButton.addEventListener('click', handleInstall);
  els.updateButton.addEventListener('click', handleAppUpdate);

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
    renderInstallHelp();
  });
}

function getActiveTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function renderThemeToggle() {
  const currentTheme = getActiveTheme();
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  els.themeToggleButton.textContent = `${nextTheme[0].toUpperCase()}${nextTheme.slice(1)} mode`;
  els.themeToggleButton.setAttribute('aria-pressed', String(currentTheme === 'dark'));
  els.themeToggleButton.title = `Switch to ${nextTheme} mode`;
}

function setTheme(theme) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[nextTheme]);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Theme persistence is optional when storage is unavailable.
  }
  renderThemeToggle();
}

function handleThemeToggle() {
  setTheme(getActiveTheme() === 'dark' ? 'light' : 'dark');
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
  els.workFormSite.innerHTML = options;
}

function findSiteByFormValue(siteId) {
  return state.sites.find((item) => String(item.id) === String(siteId));
}

async function restoreDrafts() {
  const attendanceDraft = await getDraft('attendance-form');
  workerAttendance.restoreDraft(attendanceDraft);

  const taskDraft = await getDraft('task-form');
  workerLog.restoreDraft(taskDraft);
}

function renderApp() {
  updateTopbar();
  if (!state.user) {
    showView('login');
    if (hasPendingAppUpdate()) {
      renderAppUpdateBanner();
    } else {
      renderStatusBanner(navigator.onLine ? 'Ready for sign in.' : 'Offline mode is active. Login still works only if this browser session already has data cached.', !navigator.onLine);
    }
    return;
  }

  if (state.user.role === 'worker') {
    showView('worker');
    workerLog.refreshTaskTemplates();
    workerForm.refreshWorkForms();
    historyModule.renderWorkerSummary();
    historyModule.renderHistory();
  } else {
    showView('supervisor');
    supervisorReviewModule.renderPanel();
  }

  if (hasPendingAppUpdate()) {
    renderAppUpdateBanner();
  } else {
    refreshStatusBannerForSession();
  }
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
  els.updateButton.classList.toggle('hidden', !hasPendingAppUpdate());

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
  if (hasPendingAppUpdate()) {
    renderAppUpdateBanner();
    return;
  }

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
    state.sites = await loadSites();
    fillSiteSelects();
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
    state.sites = await loadSites();
    fillSiteSelects();
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

function handleSessionExpired() {
  clearBackendSession();
  state.user = null;
  renderApp();
  renderStatusBanner('Your backend session expired. Please sign in again.');
}

function isBackendSessionError(error) {
  return error?.status === 401 || error?.status === 403;
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
      { id: 'workerEditAttendanceSiteId', label: 'Site', type: 'select', value: record.siteId || '', options: staffSitesModule.siteSelectOptions() },
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
        await historyModule.renderHistory();
        await historyModule.renderWorkerSummary();
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
    await historyModule.renderHistory();
    await historyModule.renderWorkerSummary();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not delete record.', true);
  }
}

async function handleSupervisorEditRecord(record) {
  await supervisorReviewModule.handleEditRecord(record);
}

async function handleSupervisorDecision(record, decision) {
  await supervisorReviewModule.handleDecision(record, decision);
}

async function handleSupervisorExportRecord(record, exportType) {
  await supervisorReviewModule.handleExportRecord(record, exportType);
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
  const result = await syncQueuedSubmissions();

  if (result.authBlocked) {
    clearBackendSession();
    state.user = null;
    renderApp();
    renderStatusBanner('Sign in again to sync queued submissions.', true);
    return;
  }

  if (showMessage && result.flushed) {
    renderStatusBanner(`${result.flushed} queued record${result.flushed === 1 ? '' : 's'} synced.`);
  }

  if (showMessage && result.failed) {
    renderStatusBanner(`${result.failed} queued record${result.failed === 1 ? '' : 's'} could not sync yet.`, true);
  }

  if (showMessage && !result.flushed && !result.failed && result.skipped) {
    renderStatusBanner('Queued submissions are already syncing.');
  }
}

async function handleInstall() {
  if (!state.installPrompt) {
    renderInstallHelp(true);
    renderStatusBanner(installFallbackMessage(), true);
    return;
  }

  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  els.installButton.classList.add('hidden');
  renderInstallHelp();
}

function isInstalledApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function installFallbackMessage() {
  if (isInstalledApp()) {
    return 'This app is already installed on this device.';
  }

  if (/iphone|ipad|ipod/i.test(window.navigator.userAgent)) {
    return 'On iPhone or iPad, use Safari Share, then Add to Home Screen.';
  }

  return 'Use the browser menu to install or add it to your home screen.';
}

function renderInstallHelp(forceFallback = false) {
  if (isInstalledApp()) {
    els.downloadAppButton.textContent = 'App Installed';
    els.downloadAppButton.disabled = true;
    els.downloadAppHelp.textContent = 'This app is already installed on this device.';
    return;
  }

  els.downloadAppButton.disabled = false;

  if (state.installPrompt && !forceFallback) {
    els.downloadAppButton.textContent = 'Download App';
    els.downloadAppHelp.textContent = 'Tap Download App to install it on this device.';
    return;
  }

  els.downloadAppButton.textContent = 'How to Install';
  els.downloadAppHelp.textContent = installFallbackMessage();
}

function hasPendingAppUpdate() {
  return Boolean(state.waitingServiceWorker);
}

function renderAppUpdateBanner() {
  renderStatusBanner('A new app version is ready. Tap Update App to reload when you are ready.');
}

function showServiceWorkerUpdate(worker) {
  state.waitingServiceWorker = worker;
  updateTopbar();
  renderAppUpdateBanner();
}

function handleAppUpdate() {
  const worker = state.waitingServiceWorker;
  if (!worker) return;

  els.updateButton.disabled = true;
  renderStatusBanner('Updating app...');
  worker.postMessage({ type: 'SKIP_WAITING' });

  window.setTimeout(() => {
    window.location.reload();
  }, 5000);
}

function watchServiceWorkerInstall(registration) {
  const worker = registration.installing;
  if (!worker) return;

  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      showServiceWorkerUpdate(worker);
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForServiceWorkerUpdate) return;
    reloadingForServiceWorkerUpdate = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');

      if (registration.waiting && navigator.serviceWorker.controller) {
        showServiceWorkerUpdate(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        watchServiceWorkerInstall(registration);
      });
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  });
}

init().catch((error) => {
  console.error(error);
  renderStatusBanner('The app could not start correctly. Check the browser console for details.');
});
