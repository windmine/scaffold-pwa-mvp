import {
  initializeMockData,
  getSites as getLocalSites,
  getDraft,
  getLastSyncAt
} from './mock-api.js';
import {
  login as backendLogin,
  register as backendRegister,
  startRegistration as backendStartRegistration,
  verifyRegistration as backendVerifyRegistration,
  getSession as getBackendSession,
  getCurrentUser,
  refreshSession,
  getDepartments as getBackendDepartments,
  getSites as getBackendSites,
  getSupervisorRecords,
  updateMyRecord as updateBackendMyRecord,
  deleteMyRecord as deleteBackendMyRecord,
  logout as clearBackendSession
} from './api-client.js';
import { syncQueuedSubmissions } from './offline-submissions.js';
import { createHistoryModule } from './history.js';
import { createPhotoViewer } from './photo-viewer.js';
import { createStaffSitesModule } from './staff-sites.js';
import { createSupervisorAnalyticsModule } from './supervisor-analytics.js';
import { createSupervisorMapModule } from './supervisor-map.js';
import { createSupervisorReviewModule } from './supervisor-review.js';
import { createWorkerAttendanceModule } from './worker-attendance.js';
import { createWorkerFormModule } from './worker-form.js';
import { createWorkerLogModule } from './worker-log.js';
import { createWorkerSitesModule } from './worker-sites.js';
import { createTeamWorkLogModule } from './team-work-log.js';
import { initDateInputs, setDateInputValue } from './date-inputs.js';
import { applyLanguage, initLanguageToggle } from './i18n.js';
import { formatDateTime, todayDateInput, escapeHtml } from './utils.js';
import {
  DEFAULT_BRAND_LOGO,
  DEFAULT_DEPARTMENTS,
  DEPARTMENT_LOGOS,
  MAX_TASK_LOG_PHOTOS,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  els,
  state
} from './app-shell-state.js';

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
let supervisorMapModule;
let supervisorAnalyticsModule;
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
  handleSupervisorTrashRecord,
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
  onSupervisorWorkFormsChanged: () => {
    staffSitesModule?.renderWorkFormsList();
    supervisorReviewModule?.renderAdminTaskLogForm();
  },
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

const teamWorkLogModule = createTeamWorkLogModule({
  els,
  state,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError,
  renderWorkerSummary: historyModule.renderWorkerSummary,
  renderHistory: historyModule.renderHistory
});

staffSitesModule = createStaffSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  refreshWorkForms: () => workerForm.refreshWorkForms(),
  refreshSupervisorAuditHistory: () => supervisorReviewModule?.renderAuditHistory(),
  refreshSupervisorMap: () => supervisorMapModule?.renderPanel(),
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
  renderLocationMap: () => supervisorMapModule?.renderPanel(),
  renderManagementAnalytics: () => supervisorAnalyticsModule?.renderPanel(),
  renderDepartmentScopedAdminLists: () => {
    staffSitesModule.renderSupervisorSites();
    staffSitesModule.renderFilteredStaffUsers();
    staffSitesModule.renderWorkFormsList();
  },
  onDefaultDepartmentChanged: (user) => {
    state.user = user;
    updateTopbar();
  },
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber,
  siteSelectOptions: () => staffSitesModule.siteSelectOptions()
});

supervisorMapModule = createSupervisorMapModule({
  els,
  state,
  loadAttendanceRecords: () => getSupervisorRecords(),
  normaliseAttendanceRecord: historyModule.fromBackendAttendanceRecord,
  onDecision: handleSupervisorDecision,
  onEdit: handleSupervisorEditRecord,
  refreshRecords: () => supervisorReviewModule.renderPanel(),
  renderStatusBanner
});

supervisorAnalyticsModule = createSupervisorAnalyticsModule({
  els,
  state,
  renderStatusBanner
});

async function init() {
  initDateInputs();
  await initializeMockData();
  const authRestoreMessage = await restoreBackendSession();
  if (state.user) {
    state.departments = await loadDepartments();
    initialiseDepartmentFocus();
    state.sites = await loadSites();
  } else {
    state.sites = [];
  }
  fillSiteSelects();
  setDateInputValue(els.taskDate, todayDateInput());
  setDateInputValue(els.workFormDate, todayDateInput());
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

async function loadDepartments() {
  try {
    const departments = await getBackendDepartments();
    return departments.length ? departments : DEFAULT_DEPARTMENTS;
  } catch {
    return DEFAULT_DEPARTMENTS;
  }
}

function initialiseDepartmentFocus() {
  state.departmentFocusId = state.user?.isGlobalAdmin
    ? (state.user.dashboardDepartmentId ? String(state.user.dashboardDepartmentId) : '')
    : (state.user?.departmentId ? String(state.user.departmentId) : '');
}

async function restoreBackendSession() {
  const cachedUser = getBackendSession();
  if (!cachedUser) return '';

  state.user = cachedUser;

  try {
    try {
      state.user = await refreshSession();
    } catch (refreshError) {
      if (refreshError.status !== 403) throw refreshError;
      state.user = await getCurrentUser();
    }
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
  initLanguageToggle({
    button: els.languageToggleButton,
    root: document.body,
    onChange: () => {
      renderThemeToggle();
      renderInstallHelp();
      applyLanguage();
    }
  });
  els.themeToggleButton.addEventListener('click', handleThemeToggle);
  els.loginForm.addEventListener('submit', handleLogin);
  els.registerForm.addEventListener('submit', handleRegister);
  els.sendRegistrationCodeButton.addEventListener('click', handleRegistrationStart);
  els.verifyRegistrationCodeButton.addEventListener('click', handleRegistrationVerify);
  els.restartRegistrationButton.addEventListener('click', resetRegistrationFlow);
  els.logoutButton.addEventListener('click', handleLogout);
  workerAttendance.bindEvents();
  workerLog.bindEvents();
  workerForm.bindEvents();
  workerSites.bindEvents();
  teamWorkLogModule.bindEvents();
  els.cancelWorkerEditButton.addEventListener('click', () => closeEditPanel('worker'));
  historyModule.bindEvents();
  supervisorReviewModule.bindEvents();
  supervisorMapModule.bindEvents();
  supervisorAnalyticsModule.bindEvents();
  staffSitesModule.bindEvents();
  els.cancelEditButton.addEventListener('click', closeEditPanel);
  photoViewer.bindEvents();
  els.installButton.addEventListener('click', handleInstall);
  els.downloadAppButton.addEventListener('click', handleInstall);
  els.updateButton.addEventListener('click', handleAppUpdate);
  bindAdminNavigation();

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

function bindAdminNavigation() {
  const links = [...document.querySelectorAll('.admin-desktop-nav a[href^="#"], .admin-command-link[href^="#"]')];

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;

      event.preventDefault();
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
      }

      links.forEach((item) => item.removeAttribute('aria-current'));
      link.setAttribute('aria-current', 'location');
      target.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start'
      });
    });
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
  applyLanguage(els.themeToggleButton);
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

  const teamWorkLogDraft = await getDraft('team-work-log');
  teamWorkLogModule.restoreDraft(teamWorkLogDraft);
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
    renderWorkerAccess();
    workerAttendance.renderLocationPreview();
    if (state.user.workerClass === 'leader') {
      workerLog.refreshTaskTemplates();
      workerForm.refreshWorkForms();
      teamWorkLogModule.refresh();
    }
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

  applyLanguage();
}

function renderWorkerAccess() {
  const isLeader = state.user?.role === 'worker' && state.user?.workerClass === 'leader';
  const isNormalWorker = state.user?.role === 'worker' && !isLeader;
  els.workerView.classList.toggle('normal-worker-mode', isNormalWorker);
  els.workerView.classList.toggle('leader-worker-mode', isLeader);

  document.querySelectorAll('.leader-only').forEach((element) => {
    element.classList.toggle('access-hidden', !isLeader);
  });
  document.querySelectorAll('.normal-worker-only').forEach((element) => {
    element.classList.toggle('access-hidden', !isNormalWorker);
  });
  document.querySelectorAll('#workerView [data-leader-label][data-normal-label]').forEach((element) => {
    element.textContent = isLeader ? element.dataset.leaderLabel : element.dataset.normalLabel;
  });

  const activePanel = document.querySelector('#workerView .tab-panel.active');
  if (!isLeader && activePanel?.classList.contains('leader-only')) {
    activateTab('attendanceTab');
  }
}

function showView(view) {
  const map = {
    login: els.loginView,
    worker: els.workerView,
    supervisor: els.supervisorView
  };

  document.body.dataset.activeView = view;

  Object.values(map).forEach((element) => {
    element.classList.add('hidden');
    element.classList.remove('active');
  });

  map[view].classList.remove('hidden');
  map[view].classList.add('active');
}

function departmentLogoForUser(user) {
  if (!user) return DEFAULT_BRAND_LOGO;
  const departmentName = String(user.departmentName || '').trim().toLowerCase();
  const departmentId = String(user.departmentId || '');
  const departmentKey = departmentName || DEFAULT_DEPARTMENTS.find(
    (department) => String(department.id) === departmentId
  )?.name.toLowerCase();
  return DEPARTMENT_LOGOS[departmentKey] || DEFAULT_BRAND_LOGO;
}

function updateBrandLogo() {
  if (!els.brandLogo) return;
  const logo = departmentLogoForUser(state.user);
  if (els.brandLogo.getAttribute('src') !== logo.src) {
    els.brandLogo.setAttribute('src', logo.src);
  }
  els.brandLogo.setAttribute('alt', logo.alt);
}

function updateTopbar() {
  els.updateButton.classList.toggle('hidden', !hasPendingAppUpdate());
  updateBrandLogo();
  document.body.classList.toggle('session-worker', state.user?.role === 'worker');
  document.body.classList.toggle('session-supervisor', state.user?.role === 'supervisor');
  document.body.classList.toggle('session-leader-worker', state.user?.role === 'worker' && state.user?.workerClass === 'leader');
  document.body.classList.toggle('session-normal-worker', state.user?.role === 'worker' && state.user?.workerClass !== 'leader');

  if (state.user) {
    const departmentName = state.user.departmentName || 'No department';
    els.logoutButton.classList.remove('hidden');
    els.userContext.classList.remove('hidden');
    els.userContextName.textContent = state.user.fullName || state.user.email;
    els.userContextGroup.textContent = departmentName;
    const contextBadge = state.user.isGlobalAdmin
      ? 'Super admin'
      : state.user.role === 'worker' && state.user.workerClass === 'leader'
        ? 'Leader'
        : '';
    els.userContextAdminBadge.textContent = contextBadge;
    els.userContextAdminBadge.classList.toggle('hidden', !contextBadge);
  } else {
    els.logoutButton.classList.add('hidden');
    els.userContext.classList.add('hidden');
    els.userContextName.textContent = '';
    els.userContextGroup.textContent = '';
    els.userContextAdminBadge.classList.add('hidden');
  }
}

function renderStatusBanner(message, offline = false) {
  els.statusBanner.textContent = message;
  els.statusBanner.classList.toggle('offline', offline);
  applyLanguage(els.statusBanner);
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
    resetRegistrationFlow();
    state.departments = await loadDepartments();
    initialiseDepartmentFocus();
    state.sites = await loadSites();
    fillSiteSelects();
    await syncQueueIfPossible(false);
    renderApp();
  } catch (error) {
    renderStatusBanner(error.message, false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (!state.registrationToken) {
    renderStatusBanner('Verify your email before creating an account.', true);
    return;
  }

  try {
    renderStatusBanner('Creating staff account...');
    const result = await backendRegister(
      state.registrationToken,
      els.registerPasswordInput.value,
      Number(els.registerDepartmentSelect.value)
    );
    resetRegistrationFlow();
    state.user = null;
    renderApp();
    renderStatusBanner(
      result.message || 'Account created. A supervisor must activate it before you can sign in.'
    );
  } catch (error) {
    renderStatusBanner(error.message, false);
  }
}

async function handleRegistrationStart() {
  const name = els.registerNameInput.value.trim();
  const email = els.registerEmailInput.value.trim();
  if (!name || !email || !els.registerEmailInput.checkValidity()) {
    els.registerNameInput.reportValidity();
    els.registerEmailInput.reportValidity();
    return;
  }

  try {
    renderStatusBanner('Sending verification code...');
    const result = await backendStartRegistration(name, email);
    state.registrationVerificationId = result.verification_id;
    state.registrationToken = '';
    els.registerNameInput.readOnly = true;
    els.registerEmailInput.readOnly = true;
    els.sendRegistrationCodeButton.classList.add('hidden');
    els.registrationCodeFields.classList.remove('hidden');
    els.registrationCodeInput.disabled = false;
    els.registrationCodeInput.value = result.dev_verification_code || '';
    els.registrationCodeInput.focus();
    renderStatusBanner(
      result.dev_verification_code
        ? `Verification code sent. Development code: ${result.dev_verification_code}`
        : 'Verification code sent. Check your email.'
    );
  } catch (error) {
    renderStatusBanner(error.message, true);
  }
}

async function handleRegistrationVerify() {
  if (!state.registrationVerificationId || !els.registrationCodeInput.checkValidity()) {
    els.registrationCodeInput.reportValidity();
    return;
  }

  try {
    renderStatusBanner('Verifying email...');
    const result = await backendVerifyRegistration(
      state.registrationVerificationId,
      els.registrationCodeInput.value.trim()
    );
    state.registrationToken = result.verification_token;
    state.departments = result.departments || [];
    els.registerDepartmentSelect.innerHTML = [
      '<option value="">Select a department</option>',
      ...state.departments.map(
        (department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`
      )
    ].join('');
    els.registrationCodeFields.classList.add('hidden');
    els.registrationCodeInput.disabled = true;
    els.registrationCompletionFields.classList.remove('hidden');
    els.registerDepartmentSelect.disabled = false;
    els.registerPasswordInput.disabled = false;
    els.registerPasswordInput.focus();
    renderStatusBanner('Email verified. Choose your department. A supervisor must activate the account.');
  } catch (error) {
    renderStatusBanner(error.message, true);
  }
}

function resetRegistrationFlow() {
  state.registrationVerificationId = null;
  state.registrationToken = '';
  els.registerForm.reset();
  els.registerNameInput.readOnly = false;
  els.registerEmailInput.readOnly = false;
  els.sendRegistrationCodeButton.classList.remove('hidden');
  els.registrationCodeFields.classList.add('hidden');
  els.registrationCodeInput.disabled = true;
  els.registrationCompletionFields.classList.add('hidden');
  els.registerDepartmentSelect.disabled = true;
  els.registerDepartmentSelect.innerHTML = '';
  els.registerPasswordInput.disabled = true;
}

function handleLogout() {
  clearBackendSession();
  state.user = null;
  state.sites = [];
  fillSiteSelects();
  renderApp();
}

function handleSessionExpired() {
  clearBackendSession();
  state.user = null;
  state.sites = [];
  fillSiteSelects();
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
    if (field.type === 'custom') {
      return field.html || '';
    }

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

async function handleSupervisorTrashRecord(record) {
  await supervisorReviewModule.handleTrashRecord(record);
}

async function handleSupervisorDecision(record, decision) {
  await supervisorReviewModule.handleDecision(record, decision);
}

async function handleSupervisorExportRecord(record, exportType) {
  await supervisorReviewModule.handleExportRecord(record, exportType);
}

function activateTab(targetId) {
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tabTarget === targetId;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.id === targetId;
    panel.classList.toggle('active', active);
    panel.classList.toggle('hidden', !active);
    panel.setAttribute('aria-hidden', String(!active));
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
  reloadingForServiceWorkerUpdate = true;
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
    if (!reloadingForServiceWorkerUpdate) return;
    window.location.reload();
  });

  const register = async () => {
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
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

init().catch((error) => {
  console.error(error);
  renderStatusBanner('The app could not start correctly. Check the browser console for details.');
});
