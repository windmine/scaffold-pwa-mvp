import {
  initializeMockData,
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
import { discardOfflineSubmission, syncQueuedSubmissions } from './offline-submissions.js';
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
import { applyLanguage, initLanguageToggle, translateText } from './i18n.js';
import { createUiFeedback } from './ui-feedback.js';
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

const uiFeedback = createUiFeedback({
  syncIndicator: els.syncIndicator,
  syncIndicatorText: els.syncIndicatorText,
  systemBanner: els.statusBanner,
  toastViewport: els.toastViewport,
  translateElement: applyLanguage
});

let staffSitesModule;
let supervisorReviewModule;
let supervisorMapModule;
let supervisorAnalyticsModule;
let workerAttendance;
let reloadingForServiceWorkerUpdate = false;
let appUpdateAttemptInFlight = false;
let sessionExpiryInProgress = false;

const historyModule = createHistoryModule({
  els,
  state,
  photoViewer,
  handleSessionExpired,
  renderStatusBanner,
  canWorkerEditRecord,
  handleWorkerEditRecord,
  handleWorkerDeleteRecord,
  handleRetryQueuedRecord,
  handleDiscardQueuedRecord,
  handleSupervisorEditRecord,
  handleSupervisorTrashRecord,
  handleSupervisorDecision,
  handleSupervisorExportRecord,
  onAttendanceExpectedActionChanged: () => workerAttendance?.updateActionState()
});

workerAttendance = createWorkerAttendanceModule({
  els,
  state,
  feedback: uiFeedback,
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
  feedback: uiFeedback,
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
  feedback: uiFeedback,
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
  feedback: uiFeedback,
  loadSites,
  fillSiteSelects,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError
});

const teamWorkLogModule = createTeamWorkLogModule({
  els,
  state,
  feedback: uiFeedback,
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
  feedback: uiFeedback,
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
    state.sites = await loadSitesForSession();
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
  if (!state.user) return [];

  const sites = await getBackendSites();
  state.sitesLoadError = '';
  return sites;
}

async function loadSitesForSession(options = {}) {
  try {
    return await loadSites();
  } catch (error) {
    state.sitesLoadError = error.message || 'Sites could not be loaded from the backend.';
    return options.preserveExisting ? state.sites : [];
  }
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
  [
    [els.loginForm, els.loginFeedback],
    [els.registerForm, els.registerFeedback],
    [els.workerSiteForm, els.workerSiteFeedback],
    [els.attendanceForm, els.attendanceFeedback],
    [els.teamWorkLogForm, els.teamWorkLogFeedback],
    [els.taskForm, els.taskFeedback],
    [els.workFormSubmissionForm, els.workFormFeedback],
    [els.manualAttendanceForm, els.manualAttendanceFeedback],
    [els.adminTaskLogForm, els.adminTaskLogFeedback]
  ].forEach(([form, localFeedback]) => uiFeedback.bindFormValidation(form, localFeedback));

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
  els.retryAppUpdateButton.addEventListener('click', () => {
    els.appUpdatePausedDialog.close();
    void handleAppUpdate();
  });
  els.keepEditingWorkFormButton.addEventListener('click', keepEditingWorkForm);
  bindAdminNavigation();

  document.querySelectorAll('[data-tab-target]').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.tabTarget));
  });

  window.addEventListener('online', async () => {
    uiFeedback.setSyncState('syncing', 'Online - checking queued submissions');
    const syncResult = await syncQueueIfPossible(true);
    if (!state.user) return;

    await refreshSitesAfterReconnect();
    if (state.user.role === 'worker') {
      if (state.user.workerClass === 'leader' && !state.workForms.length) {
        await workerForm.refreshWorkForms();
      }
      await historyModule.renderWorkerSummary();
      await historyModule.renderHistory();
    } else {
      await supervisorReviewModule.renderPanel();
    }

    if (syncResult?.failed) {
      renderStatusBanner(`${syncResult.failed} queued record${syncResult.failed === 1 ? '' : 's'} still need attention. Open My history to retry or discard them.`, true);
    } else if (state.sitesLoadError) {
      renderSystemBanner(`You are back online, but Sites are unavailable: ${state.sitesLoadError}`, {
        tone: 'error'
      });
    } else {
      uiFeedback.hideSystemBanner();
      renderStatusBanner('You are back online. Queued records have been checked for sync.');
    }
  });

  window.addEventListener('offline', () => {
    uiFeedback.setSyncState('offline', 'Offline - submissions will wait');
    renderStatusBanner('You are offline. New submissions will stay on this device until you reconnect.', true);
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installButton.classList.remove('hidden');
    renderInstallHelp();
  });
}

const ADMIN_WORKSPACES = Object.freeze({
  overview: { label: 'Overview', panelId: 'adminOverview', headingId: 'adminOverviewTitle' },
  review: { label: 'Review', panelId: 'adminReviewWorkspace', headingId: 'adminReviewWorkspaceTitle' },
  reports: { label: 'Reports', panelId: 'adminReportsWorkspace', headingId: 'adminReportsWorkspaceTitle' },
  people: { label: 'People & Sites', panelId: 'adminPeopleWorkspace', headingId: 'adminPeopleWorkspaceTitle' },
  forms: { label: 'Forms', panelId: 'adminFormsWorkspace', headingId: 'adminFormsWorkspaceTitle' },
  audit: { label: 'Audit', panelId: 'adminAuditWorkspace', headingId: 'adminAuditWorkspaceTitle' }
});

function closeAdminWorkspaceDrawer() {
  if (els.adminWorkspaceDrawer.open) els.adminWorkspaceDrawer.close();
  els.adminMobileMenuButton.setAttribute('aria-expanded', 'false');
}

function adminWorkspaceDestination(target) {
  const panel = target?.matches?.('[data-admin-workspace-panel]')
    ? target
    : target?.closest?.('[data-admin-workspace-panel]');
  const workspace = panel?.dataset.adminWorkspacePanel;
  return workspace && ADMIN_WORKSPACES[workspace] ? { workspace, panel, target } : null;
}

function adminWorkspaceDestinationFromHash() {
  let targetId;
  try {
    targetId = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return null;
  }
  return targetId ? adminWorkspaceDestination(document.getElementById(targetId)) : null;
}

function updateAdminWorkspaceHistory(targetId) {
  if (!targetId || window.location.hash === `#${targetId}`) return;
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = targetId;
  window.history.pushState({ adminWorkspace: state.adminWorkspace }, '', nextUrl);
}

function activateAdminWorkspace(workspaceId, options = {}) {
  const workspace = ADMIN_WORKSPACES[workspaceId] ? workspaceId : 'overview';
  const config = ADMIN_WORKSPACES[workspace];
  const panels = [...document.querySelectorAll('[data-admin-workspace-panel]')];
  const nextPanel = document.getElementById(config.panelId);
  if (!nextPanel) return;

  if (state.adminWorkspace !== workspace && !els.supervisorEditPanel.classList.contains('hidden')) {
    closeEditPanel();
  }

  const activeElementWillHide = panels.some((panel) => (
    panel !== nextPanel && !panel.hidden && panel.contains(document.activeElement)
  ));
  panels.forEach((panel) => {
    panel.hidden = panel !== nextPanel;
  });
  state.adminWorkspace = workspace;

  document.querySelectorAll('[data-admin-workspace-target]').forEach((link) => {
    if (link.dataset.adminWorkspaceTarget === workspace) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
  els.adminMobileWorkspaceLabel.textContent = config.label;

  const target = options.target || nextPanel;
  if (target instanceof HTMLDetailsElement) target.open = true;
  closeAdminWorkspaceDrawer();

  if (options.updateHistory) {
    updateAdminWorkspaceHistory(target.id || config.panelId);
  }

  if (options.focus || activeElementWillHide) {
    window.requestAnimationFrame(() => {
      if (target !== nextPanel) {
        const targetFocus = target instanceof HTMLDetailsElement
          ? target.querySelector(':scope > summary')
          : target;
        if (targetFocus && !targetFocus.matches('a, button, input, select, textarea, summary, [tabindex]')) {
          targetFocus.setAttribute('tabindex', '-1');
        }
        targetFocus?.focus?.({ preventScroll: true });
        target.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start'
        });
        return;
      }

      const heading = document.getElementById(config.headingId);
      heading?.focus({ preventScroll: true });
      nextPanel.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start'
      });
    });
  }

  if (workspace === 'review' && els.locationMapDetails.open) {
    window.requestAnimationFrame(() => supervisorMapModule?.renderPanel());
  }
  if (workspace === 'people') {
    window.requestAnimationFrame(() => staffSitesModule?.refreshSiteMapIfVisible());
  }
}

function renderAdminWorkspaceFromLocation(options = {}) {
  const destination = adminWorkspaceDestinationFromHash();
  activateAdminWorkspace(destination?.workspace || 'overview', {
    ...options,
    target: destination?.target || null
  });
}

function bindAdminNavigation() {
  document.querySelectorAll('[data-admin-workspace-target]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const workspace = link.dataset.adminWorkspaceTarget;
      const target = document.querySelector(link.getAttribute('href'));
      activateAdminWorkspace(workspace, {
        target,
        focus: true,
        updateHistory: true
      });
    });
  });

  document.querySelectorAll('.admin-command-link[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      const destination = adminWorkspaceDestination(target);
      if (!destination) return;
      event.preventDefault();
      activateAdminWorkspace(destination.workspace, {
        target,
        focus: true,
        updateHistory: true
      });
    });
  });

  els.adminMobileMenuButton.addEventListener('click', () => {
    if (!els.adminWorkspaceDrawer.open) {
      els.adminWorkspaceDrawer.showModal();
      els.adminMobileMenuButton.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(() => {
        els.adminWorkspaceDrawer
          .querySelector(`[data-admin-workspace-target="${state.adminWorkspace}"]`)
          ?.focus();
      });
    }
  });
  els.adminWorkspaceDrawerCloseButton.addEventListener('click', closeAdminWorkspaceDrawer);
  els.adminWorkspaceDrawer.addEventListener('close', () => {
    els.adminMobileMenuButton.setAttribute('aria-expanded', 'false');
  });
  els.adminWorkspaceDrawer.addEventListener('click', (event) => {
    if (event.target === els.adminWorkspaceDrawer) closeAdminWorkspaceDrawer();
  });

  const desktopWorkspaceMedia = window.matchMedia('(min-width: 980px)');
  desktopWorkspaceMedia.addEventListener('change', (event) => {
    if (!event.matches || !els.adminWorkspaceDrawer.open) return;
    closeAdminWorkspaceDrawer();
    window.requestAnimationFrame(() => {
      document
        .querySelector(`.admin-desktop-nav [data-admin-workspace-target="${state.adminWorkspace}"]`)
        ?.focus();
    });
  });
  let historyNavigationFrame = 0;
  const handleHistoryNavigation = () => {
    window.cancelAnimationFrame(historyNavigationFrame);
    historyNavigationFrame = window.requestAnimationFrame(() => {
      if (document.body.dataset.activeView === 'supervisor') {
        renderAdminWorkspaceFromLocation({ focus: true });
      }
    });
  };
  window.addEventListener('popstate', handleHistoryNavigation);
  window.addEventListener('hashchange', handleHistoryNavigation);

  activateAdminWorkspace(state.adminWorkspace);
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
  const emptyLabel = state.sitesLoadError
    ? 'Sites unavailable - reconnect and try again'
    : state.sites.length
      ? 'Select a site'
      : 'No sites available';
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`]
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

async function refreshSitesAfterReconnect() {
  const selectedSiteIds = new Map([
    [els.attendanceSite, els.attendanceSite.value],
    [els.taskSite, els.taskSite.value],
    [els.workFormSite, els.workFormSite.value]
  ]);

  state.sites = await loadSitesForSession({ preserveExisting: true });
  fillSiteSelects();
  selectedSiteIds.forEach((siteId, select) => {
    if (siteId && [...select.options].some((option) => option.value === siteId)) {
      select.value = siteId;
    }
  });
  workerAttendance.renderLocationPreview();
}

function findSiteByFormValue(siteId) {
  return state.sites.find((item) => String(item.id) === String(siteId));
}

async function restoreDrafts() {
  await restoreWorkerSubmissionDrafts();

  const teamWorkLogDraft = await getDraft('team-work-log');
  teamWorkLogModule.restoreDraft(teamWorkLogDraft);
}

async function restoreWorkerSubmissionDrafts() {
  const attendanceDraft = await getDraft('attendance-form');
  workerAttendance.restoreDraft(attendanceDraft);

  const taskDraft = await getDraft('task-form');
  workerLog.restoreDraft(taskDraft);
}

function clearWorkerSessionState() {
  workerAttendance.clearSessionState();
  workerLog.clearSessionState();
  workerForm.clearSessionState();
  state.workForms = [];
  state.teamWorkLogMembers = [];
  els.teamWorkLogForm.reset();
  els.teamWorkLogEntries.innerHTML = '';
  els.teamWorkLogHistory.innerHTML = '';
}

function renderApp() {
  updateTopbar();
  if (!state.user) {
    showView('login');
    if (hasPendingAppUpdate()) {
      renderAppUpdateBanner();
    } else {
      uiFeedback.hideSystemBanner();
    }
    void refreshStatusBannerForSession();
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
    const shouldFocusWorkspace = !els.supervisorView.contains(document.activeElement);
    showView('supervisor');
    renderAdminWorkspaceFromLocation({ focus: shouldFocusWorkspace });
    supervisorReviewModule.renderPanel();
  }

  if (hasPendingAppUpdate()) {
    renderAppUpdateBanner();
  } else if (state.sitesLoadError) {
    renderSystemBanner(`Sites are unavailable: ${state.sitesLoadError}`, { tone: 'error' });
  } else {
    uiFeedback.hideSystemBanner();
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
  const leavingSupervisor = view !== 'supervisor' && els.supervisorView.classList.contains('active');
  if (leavingSupervisor) closeAdminWorkspaceDrawer();

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

  if (leavingSupervisor && view === 'login') {
    window.requestAnimationFrame(() => els.emailInput.focus());
  }
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

function renderStatusBanner(message, offline = false, options = {}) {
  return uiFeedback.show(message, offline, options);
}

function renderSystemBanner(message, options = {}) {
  uiFeedback.showSystemBanner(message, options);
}

async function refreshStatusBannerForSession() {
  const lastSyncAt = await getLastSyncAt();
  if (!navigator.onLine) {
    uiFeedback.setSyncState('offline', 'Offline - submissions will wait');
    return;
  }

  uiFeedback.setSyncState(
    'online',
    lastSyncAt ? `Online - last sync attempt ${formatDateTime(lastSyncAt)}` : 'Online'
  );
}

async function handleLogin(event) {
  event.preventDefault();
  if (els.loginSubmitButton.getAttribute('aria-busy') === 'true') return;
  uiFeedback.clearLocal(els.loginFeedback);
  uiFeedback.setButtonBusy(els.loginSubmitButton, true, 'Signing in...');
  try {
    renderStatusBanner('Signing in with the backend...', false, {
      local: els.loginFeedback,
      tone: 'info'
    });
    const signedInUser = await backendLogin(els.emailInput.value.trim(), els.passwordInput.value);
    clearWorkerSessionState();
    state.user = signedInUser;
    resetRegistrationFlow();
    state.departments = await loadDepartments();
    initialiseDepartmentFocus();
    state.sites = await loadSitesForSession();
    fillSiteSelects();
    await restoreWorkerSubmissionDrafts();
    await syncQueueIfPossible(false);
    uiFeedback.clearLocal(els.loginFeedback);
    renderApp();
  } catch (error) {
    renderStatusBanner(error.message, false, {
      local: els.loginFeedback,
      tone: 'error'
    });
  } finally {
    uiFeedback.setButtonBusy(els.loginSubmitButton, false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (!state.registrationToken) {
    renderStatusBanner('Verify your email before creating an account.', true, {
      local: els.registerFeedback,
      field: els.registrationCodeInput,
      tone: 'error'
    });
    return;
  }

  if (els.registerSubmitButton.getAttribute('aria-busy') === 'true') return;
  uiFeedback.clearLocal(els.registerFeedback);
  uiFeedback.setButtonBusy(els.registerSubmitButton, true, 'Creating account...');
  try {
    renderStatusBanner('Creating staff account...', false, {
      local: els.registerFeedback,
      tone: 'info'
    });
    const result = await backendRegister(
      state.registrationToken,
      els.registerPasswordInput.value,
      Number(els.registerDepartmentSelect.value)
    );
    resetRegistrationFlow();
    state.user = null;
    renderApp();
    renderStatusBanner(
      result.message || 'Account created. A supervisor must activate it before you can sign in.',
      false,
      { tone: 'success' }
    );
  } catch (error) {
    renderStatusBanner(error.message, false, {
      local: els.registerFeedback,
      tone: 'error'
    });
  } finally {
    uiFeedback.setButtonBusy(els.registerSubmitButton, false);
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

  if (els.sendRegistrationCodeButton.getAttribute('aria-busy') === 'true') return;
  uiFeedback.clearLocal(els.registerFeedback);
  uiFeedback.setButtonBusy(els.sendRegistrationCodeButton, true, 'Sending code...');
  try {
    renderStatusBanner('Sending verification code...', false, {
      local: els.registerFeedback,
      tone: 'info'
    });
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
        : 'Verification code sent. Check your email.',
      false,
      { local: els.registerFeedback, tone: 'success' }
    );
  } catch (error) {
    renderStatusBanner(error.message, true, {
      local: els.registerFeedback,
      tone: 'error'
    });
  } finally {
    uiFeedback.setButtonBusy(els.sendRegistrationCodeButton, false);
  }
}

async function handleRegistrationVerify() {
  if (!state.registrationVerificationId || !els.registrationCodeInput.checkValidity()) {
    els.registrationCodeInput.reportValidity();
    return;
  }

  if (els.verifyRegistrationCodeButton.getAttribute('aria-busy') === 'true') return;
  uiFeedback.clearLocal(els.registerFeedback);
  uiFeedback.setButtonBusy(els.verifyRegistrationCodeButton, true, 'Verifying...');
  try {
    renderStatusBanner('Verifying email...', false, {
      local: els.registerFeedback,
      tone: 'info'
    });
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
    renderStatusBanner('Email verified. Choose your department. A supervisor must activate the account.', false, {
      local: els.registerFeedback,
      tone: 'success'
    });
  } catch (error) {
    renderStatusBanner(error.message, true, {
      local: els.registerFeedback,
      field: els.registrationCodeInput,
      tone: 'error'
    });
  } finally {
    uiFeedback.setButtonBusy(els.verifyRegistrationCodeButton, false);
  }
}

function resetRegistrationFlow() {
  uiFeedback.clearLocal(els.registerFeedback);
  uiFeedback.clearFieldError(els.registrationCodeInput);
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

async function handleLogout() {
  if (els.logoutButton.getAttribute('aria-busy') === 'true') return;
  if (workerForm.hasUnsavedInput()) {
    uiFeedback.setButtonBusy(els.logoutButton, true, 'Saving draft...');
    try {
      await workerForm.flushPendingDrafts();
    } catch {
      uiFeedback.setButtonBusy(els.logoutButton, false);
      if (state.user?.role === 'worker' && state.user?.workerClass === 'leader') {
        activateTab('formTab');
        workerForm.focusUnsavedInput();
      }
      renderStatusBanner('Your Work Form is not saved yet. Keep editing and try again before logging out.', true, {
        local: els.workFormFeedback,
        tone: 'error'
      });
      return;
    }
    uiFeedback.setButtonBusy(els.logoutButton, false);
  }
  uiFeedback.clearAll();
  clearWorkerSessionState();
  clearBackendSession();
  state.user = null;
  state.sites = [];
  state.sitesLoadError = '';
  fillSiteSelects();
  renderApp();
}

function handleSessionExpired(message = 'Your backend session expired. Please sign in again.') {
  if (sessionExpiryInProgress) return;
  sessionExpiryInProgress = true;

  const finish = () => {
    uiFeedback.clearAll();
    clearWorkerSessionState();
    clearBackendSession();
    state.user = null;
    state.sites = [];
    state.sitesLoadError = '';
    fillSiteSelects();
    renderApp();
    renderStatusBanner(message);
    sessionExpiryInProgress = false;
  };

  if (state.submittingWorkForm) {
    window.setTimeout(() => {
      sessionExpiryInProgress = false;
      handleSessionExpired(message);
    }, 150);
    return;
  }

  if (workerForm.hasUnsavedInput()) {
    void workerForm.flushPendingDrafts()
      .then(finish)
      .catch(() => {
        sessionExpiryInProgress = false;
        if (state.user?.role === 'worker' && state.user?.workerClass === 'leader') {
          activateTab('formTab');
          workerForm.focusUnsavedInput();
        }
        renderStatusBanner('Your session expired, but this Work Form is not saved on this device. Keep this page open and try saving again.', true, {
          local: els.workFormFeedback,
          tone: 'error'
        });
      });
    return;
  }
  finish();
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
      if (!window.confirm(translateText('Save changes to this pending check-in/check-out?'))) return;
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

  if (!window.confirm(translateText('Delete this pending check-in/check-out?'))) return;

  try {
    await deleteBackendMyRecord(record.backendRecordId);
    renderStatusBanner('Attendance deleted.');
    await historyModule.renderHistory();
    await historyModule.renderWorkerSummary();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not delete record.', true);
  }
}

async function handleRetryQueuedRecord() {
  if (!navigator.onLine) {
    renderStatusBanner('Reconnect to the internet before retrying this submission.', true);
    return;
  }

  const result = await syncQueueIfPossible(true);
  await historyModule.renderHistory();
  await historyModule.renderWorkerSummary();
  if (result?.failed) {
    renderStatusBanner('Sync still failed. Check the error in My history, then discard and resubmit if the photo needs replacing.', true);
  }
}

async function handleDiscardQueuedRecord(record) {
  if (!window.confirm(translateText('Discard this unsynced submission from this device? You can then create it again with corrected details or photos.'))) return;

  try {
    await discardOfflineSubmission(record.id);
    renderStatusBanner('Unsynced submission discarded. You can create it again now.');
    await historyModule.renderHistory();
    await historyModule.renderWorkerSummary();
  } catch (error) {
    renderStatusBanner(error.message || 'Could not discard this offline submission.', true);
  }
}

async function handleSupervisorEditRecord(record) {
  await supervisorReviewModule.handleEditRecord(record);
}

async function handleSupervisorTrashRecord(record) {
  await supervisorReviewModule.handleTrashRecord(record);
}

async function handleSupervisorDecision(record, decision, button) {
  await supervisorReviewModule.handleDecision(record, decision, button);
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
  if (state.user && navigator.onLine) {
    uiFeedback.setSyncState('syncing', 'Online - syncing');
  }
  const result = await syncQueuedSubmissions();

  if (result.authBlocked) {
    handleSessionExpired('Sign in again to sync queued submissions.');
    return result;
  }

  if (!navigator.onLine) {
    uiFeedback.setSyncState('offline', 'Offline - submissions will wait');
  } else if (result.failed || result.ownershipBlocked || result.invalidBlocked) {
    const attentionCount = result.failed + result.ownershipBlocked + result.invalidBlocked;
    uiFeedback.setSyncState('attention', `Online - ${attentionCount} submission${attentionCount === 1 ? '' : 's'} need attention`);
  } else if (!result.noActiveWorker) {
    uiFeedback.setSyncState('synced', result.flushed ? `Online - ${result.flushed} synced` : 'Online - queue checked');
  } else {
    uiFeedback.setSyncState('online', 'Online');
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

  return result;
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
  renderSystemBanner('A new app version is ready. Your Work Form will be saved before the app reloads.', {
    tone: 'info'
  });
}

function showServiceWorkerUpdate(worker) {
  state.waitingServiceWorker = worker;
  updateTopbar();
  renderAppUpdateBanner();
}

function showAppUpdatePausedDialog(message) {
  els.appUpdatePausedDescription.textContent = message
    || 'This Work Form has changes that are not saved on this device. Updating now could lose them.';
  applyLanguage(els.appUpdatePausedDialog);
  if (!els.appUpdatePausedDialog.open) els.appUpdatePausedDialog.showModal();
  window.requestAnimationFrame(() => els.keepEditingWorkFormButton.focus());
}

function keepEditingWorkForm() {
  if (els.appUpdatePausedDialog.open) els.appUpdatePausedDialog.close();
  if (state.user?.role === 'worker' && state.user?.workerClass === 'leader') {
    activateTab('formTab');
    window.requestAnimationFrame(() => workerForm.focusUnsavedInput());
  }
}

async function handleAppUpdate() {
  let worker = state.waitingServiceWorker;
  if (!worker || appUpdateAttemptInFlight) return;

  appUpdateAttemptInFlight = true;
  uiFeedback.setButtonBusy(els.updateButton, true, 'Saving before update...');
  let draftReadiness;
  try {
    draftReadiness = await workerForm.prepareForAppUpdate();
  } catch {
    draftReadiness = {
      safe: false,
      message: 'This Work Form has changes that are not saved on this device. Updating now could lose them.'
    };
  }
  if (!draftReadiness.safe) {
    appUpdateAttemptInFlight = false;
    uiFeedback.setButtonBusy(els.updateButton, false);
    showAppUpdatePausedDialog(draftReadiness.message);
    return;
  }

  worker = state.waitingServiceWorker;
  if (!worker) {
    workerForm.cancelAppUpdatePreparation();
    appUpdateAttemptInFlight = false;
    uiFeedback.setButtonBusy(els.updateButton, false);
    renderSystemBanner('The app update is no longer waiting. Your Work Form draft is saved.', { tone: 'info' });
    return;
  }

  try {
    worker.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    workerForm.cancelAppUpdatePreparation();
    appUpdateAttemptInFlight = false;
    uiFeedback.setButtonBusy(els.updateButton, false);
    renderSystemBanner('Could not start the app update. Your Work Form draft is saved; try Update App again.', {
      tone: 'error'
    });
    return;
  }
  reloadingForServiceWorkerUpdate = true;
  renderSystemBanner('Draft saved. Updating app...', { tone: 'info' });
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
  renderSystemBanner('The app could not start correctly. Check the browser console for details.', {
    tone: 'error'
  });
});
