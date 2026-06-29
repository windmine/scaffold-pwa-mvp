import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManagementAnalytics } from '../assets/js/supervisor-analytics.js';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function hasFile(relativePath) {
  return existsSync(join(root, relativePath));
}

const checks = [];

function check(name, test) {
  checks.push({ name, test });
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

const sourceIndex = read('index.html');
const sourceApp = read('assets/js/app.js');
const sourceApiClient = read('assets/js/api-client.js');
const sourceSupervisorReview = read('assets/js/supervisor-review.js');
const sourceSupervisorAnalytics = read('assets/js/supervisor-analytics.js');
const sourceSupervisorMap = read('assets/js/supervisor-map.js');
const sourceWorkerLog = read('assets/js/worker-log.js');
const sourceWorkerSites = read('assets/js/worker-sites.js');
const sourceSiteMapPicker = read('assets/js/site-map-picker.js');
const sourceTeamWorkLog = read('assets/js/team-work-log.js');
const sourceWorker = read('sw.js');
const sourceOfflineQueue = read('assets/js/offline-submissions.js');
const sourceWorkFormFields = read('assets/js/work-form-fields.js');
const sourceDateInputs = read('assets/js/date-inputs.js');
const sourceStyles = read('assets/css/styles.css');
const viteConfig = read('vite.config.js');

const distIndex = hasFile('dist/index.html') ? read('dist/index.html') : '';
const distWorker = hasFile('dist/sw.js') ? read('dist/sw.js') : '';

check('production build exists', () => [
  'dist/index.html',
  'dist/sw.js',
  'dist/offline.html',
  'dist/manifest.webmanifest'
].every(hasFile));

[
  'dist/assets/js/date-inputs.js',
  'dist/assets/js/site-map-picker.js',
  'dist/assets/js/team-work-log.js',
  'dist/assets/js/worker-sites.js',
  'dist/assets/icons/leader-logo-export.png',
  'dist/assets/icons/leader-icon.svg',
  'dist/assets/icons/apple-touch-icon.png',
  'dist/assets/icons/icon-192.png',
  'dist/assets/icons/icon-512.png',
  'dist/assets/icons/maskable-512.png'
].forEach((file) => {
  check(`${file} exists`, () => hasFile(file));
});

check('production HTML keeps stable PWA links', () => (
  distIndex.includes('href="/manifest.webmanifest"')
  && distIndex.includes('href="/assets/icons/leader-logo-export.png"')
  && distIndex.includes('href="/assets/icons/apple-touch-icon.png"')
));

[
  'statusBanner',
  'themeToggleButton',
  'installButton',
  'downloadAppButton',
  'updateButton',
  'loginForm',
  'registerForm',
  'sendRegistrationCodeButton',
  'registrationCodeFields',
  'registrationCodeInput',
  'verifyRegistrationCodeButton',
  'registrationCompletionFields',
  'registerDepartmentSelect',
  'workerView',
  'workerSiteMap',
  'workerSiteMapStatus',
  'teamLogTab',
  'teamWorkLogForm',
  'teamWorkLogWeekStart',
  'teamWorkLogEntries',
  'addTeamWorkLogEntryButton',
  'submitTeamWorkLogButton',
  'teamWorkLogAutosaveStatus',
  'teamWorkLogHistory',
  'supervisorView',
  'adminOverview',
  'reviewQueueDetails',
  'auditHistoryDetails',
  'workFormsDetails',
  'sitesDetails',
  'siteUseLocationButton',
  'siteMap',
  'siteMapStatus',
  'staffUsersDetails',
  'staffWorkerClassSelect',
  'attendanceSite',
  'captureLocationButton',
  'checkInButton',
  'checkOutButton',
  'taskForm',
  'workFormSubmissionForm',
  'reviewQueueList',
  'manualAttendanceDetails',
  'manualAttendanceForm',
  'manualAttendanceWorker',
  'manualAttendanceSite',
  'manualAttendanceType',
  'manualAttendanceTime',
  'manualAttendanceNote',
  'manualAttendanceSubmitButton',
  'adminTaskLogDetails',
  'adminTaskLogForm',
  'adminTaskLogUser',
  'adminTaskLogSite',
  'adminTaskLogDate',
  'adminTaskLogDescription',
  'adminTaskLogSubmitButton',
  'rubbishBinDetails',
  'rubbishBinCount',
  'rubbishBinList',
  'refreshRubbishBinButton',
  'supervisorDepartmentFilter',
  'saveDefaultDepartmentButton',
  'auditEventsList',
  'refreshAuditButton',
  'managementAnalyticsDetails',
  'analyticsTrendChart',
  'analyticsExceptionSummary',
  'analyticsExceptionList',
  'analyticsSiteSummary',
  'analyticsFormCharts',
  'locationMapDetails',
  'locationReviewMap',
  'locationMapHistory'
].forEach((id) => {
  check(`#${id} exists in the app shell`, () => sourceIndex.includes(`id="${id}"`));
});

check('mobile viewport and camera/photo controls exist', () => (
  sourceIndex.includes('name="viewport"')
  && sourceIndex.includes('capture="environment"')
  && sourceIndex.includes('id="taskPhoto" type="file" accept="image/*" multiple')
  && sourceIndex.includes('id="workFormPhotos" type="file" accept="image/*" multiple')
));

check('desktop admin workspace navigation opens and links management sections', () => (
  sourceIndex.includes('class="admin-desktop-nav"')
  && sourceIndex.includes('class="admin-workspace"')
  && sourceIndex.includes('href="#reviewQueueDetails"')
  && sourceIndex.includes('href="#staffUsersDetails"')
  && sourceApp.includes('bindAdminNavigation()')
  && sourceApp.includes('target instanceof HTMLDetailsElement')
  && sourceStyles.includes('grid-template-columns: minmax(214px, 240px) minmax(0, 1fr)')
  && sourceStyles.includes('grid-template-columns: repeat(12, minmax(0, 1fr))')
  && sourceStyles.includes('@media (min-width: 1240px)')
));

check('localized date inputs stay inside mobile form boundaries', () => (
  sourceApp.includes("import { initDateInputs, setDateInputValue } from './date-inputs.js'")
  && sourceApp.includes('initDateInputs()')
  && sourceDateInputs.includes("input[type=\"date\"]")
  && sourceDateInputs.includes("display.textContent = input.value || '-'")
  && sourceStyles.includes('.date-input-shell > input[type="date"]')
  && sourceStyles.includes('opacity: 0')
  && !sourceStyles.includes('::-webkit-date-and-time-value')
));

check('verified registration gates department selection', () => (
  sourceApiClient.includes('"/auth/registration/start"')
  && sourceApiClient.includes('"/auth/registration/verify"')
  && sourceApiClient.includes('verification_token')
  && sourceApp.includes('handleRegistrationStart')
  && sourceApp.includes('handleRegistrationVerify')
  && sourceApp.includes('registrationCompletionFields.classList.remove')
  && sourceApp.includes('<option value="">Select a department</option>')
  && sourceIndex.includes('registerDepartmentSelect" disabled required')
));

check('theme toggle is persistent and available before paint', () => (
  sourceIndex.includes("localStorage.getItem('leader-theme')")
  && sourceIndex.includes('id="themeToggleButton"')
  && sourceApp.includes("localStorage.setItem(THEME_STORAGE_KEY, nextTheme)")
  && sourceApp.includes("document.documentElement.dataset.theme")
));

check('same-origin phone proxy is configured', () => (
  viteConfig.includes("'/api'")
  && viteConfig.includes("'/uploads'")
  && viteConfig.includes("basicSsl()")
  && viteConfig.includes("host: '0.0.0.0'")
));

check('service worker update prompt is wired', () => (
  sourceIndex.includes('id="updateButton"')
  && sourceApp.includes('waitingServiceWorker')
  && sourceApp.includes('registration.waiting')
  && sourceApp.includes('updatefound')
  && sourceApp.includes('controllerchange')
  && sourceApp.includes("worker.postMessage({ type: 'SKIP_WAITING' })")
  && sourceWorker.includes("event.data?.type === 'SKIP_WAITING'")
));

check('visible app download button is wired', () => (
  sourceIndex.includes('id="downloadAppButton"')
  && sourceIndex.includes('id="downloadAppHelp"')
  && sourceApp.includes('downloadAppButton')
  && sourceApp.includes('installFallbackMessage')
  && sourceApp.includes('beforeinstallprompt')
));

check('production service worker uses the current app shell rules', () => (
  distWorker.includes('NETWORK_ONLY_PREFIXES')
  && distWorker.includes("'/photo-uploads'")
  && distWorker.includes("'/uploads'")
  && distWorker.includes('event.respondWith(fetch(request))')
  && distWorker.includes('cacheFirst(request)')
));

check('service worker does not auto-activate updates on install', () => {
  const installHandler = sourceWorker.match(/self\.addEventListener\('install'[\s\S]*?\n}\);/);
  return Boolean(installHandler) && !installHandler[0].includes('skipWaiting');
});

check('offline queue covers worker forms, signatures, and photos', () => (
  sourceOfflineQueue.includes('createBackendFormSubmission')
  && sourceOfflineQueue.includes('uploadSignatureAnswers')
  && sourceOfflineQueue.includes('dataUrlToBlob')
  && sourceOfflineQueue.includes("record.type === 'form'")
  && sourceOfflineQueue.includes('uploadRecordPhotos')
));

check('offline retry is single-flight and auth-aware', () => (
  sourceOfflineQueue.includes('syncQueuePromise')
  && sourceOfflineQueue.includes('markSyncing')
  && sourceOfflineQueue.includes('markAuthBlocked')
  && sourceOfflineQueue.includes('isStaleSyncingRecord')
  && sourceOfflineQueue.includes('authBlocked')
  && sourceApp.includes('Sign in again to sync queued submissions.')
));

check('offline sync uses client submission idempotency', () => (
  sourceOfflineQueue.includes('clientSubmissionId')
  && sourceOfflineQueue.includes('client_submission_id')
  && read('backend/app/schemas.py').includes('client_submission_id')
  && read('backend/app/models.py').includes('client_submission_id')
  && read('backend/app/use_cases/attendance.py').includes('client_submission_id')
  && read('backend/app/use_cases/task_logs.py').includes('client_submission_id')
  && read('backend/app/use_cases/work_forms.py').includes('client_submission_id')
));

check('partial uploads persist progress before retry', () => (
  sourceOfflineQueue.includes('onProgress')
  && sourceOfflineQueue.includes('await options.onProgress?.(record)')
  && sourceOfflineQueue.includes('onProgress: persistLocalSubmission')
));

check('required handwritten signatures are rendered and enforced', () => (
  sourceWorkFormFields.includes('data-signature-canvas')
  && sourceWorkFormFields.includes('canvas.toDataURL')
  && sourceWorkFormFields.includes('field.required')
  && sourceWorkFormFields.includes('throw new Error(`${field.label} is required.`)')
));

check('advanced work form fields and photo timestamps are wired', () => (
  sourceIndex.includes('time_range|Work time|required')
  && sourceWorkFormFields.includes("field.type === 'section'")
  && sourceWorkFormFields.includes("field.type === 'time_range'")
  && sourceWorkFormFields.includes("field.type === 'repeat'")
  && sourceWorkFormFields.includes('evaluateFormula')
  && sourceWorkFormFields.includes('conditionMet')
  && sourceStyles.includes('input[type="time"]')
  && sourceStyles.includes('color-scheme: light')
  && sourceStyles.includes('::-webkit-calendar-picker-indicator')
  && sourceOfflineQueue.includes('photo_metadata')
  && read('backend/app/schemas.py').includes('photo_metadata')
  && read('backend/app/schemas.py').includes('show_if')
  && read('backend/app/use_cases/common.py').includes('"formula"')
  && read('backend/app/use_cases/common.py').includes('"repeat"')
  && read('backend/app/use_cases/common.py').includes('"time_range"')
));

check('worker Log tab uses the Daywork work form path', () => (
  sourceIndex.includes('id="dayworkFormFields"')
  && sourceIndex.includes('Submit daywork log')
  && sourceWorkerLog.includes("type: 'form'")
  && sourceWorkerLog.includes('DAYWORK_FIELD_PREFIX')
  && sourceWorkerLog.includes('selectedDayworkForm')
));

check('workers can add missing sites', () => (
  sourceIndex.includes('id="workerSiteForm"')
  && sourceIndex.includes('Use current location')
  && sourceIndex.includes('id="workerSiteMap"')
  && sourceApiClient.includes('createWorkerSite')
  && sourceWorkerSites.includes('createBackendWorkerSite')
  && sourceWorkerSites.includes('createSiteMapPicker')
  && read('backend/app/main.py').includes('@app.post("/sites")')
));

check('normal workers are attendance-only and leaders can submit weekly team logs', () => (
  sourceIndex.includes('class="leader-only" data-tab-target="teamLogTab"')
  && sourceIndex.includes('id="staffWorkerClassSelect"')
  && sourceApp.includes("state.user.workerClass === 'leader'")
  && sourceApp.includes("element.classList.toggle('access-hidden', !isLeader)")
  && sourceApiClient.includes('"/team-work-logs"')
  && sourceApiClient.includes('"/team-work-log-members"')
  && sourceTeamWorkLog.includes('function entriesPayload')
  && sourceTeamWorkLog.includes("type=\"checkbox\"")
  && sourceTeamWorkLog.includes('data-team-member-search')
  && sourceTeamWorkLog.includes('rows.flatMap')
  && sourceTeamWorkLog.includes('selectedMemberIds')
  && sourceTeamWorkLog.includes('function timeOptions')
  && sourceTeamWorkLog.includes('class="team-time-select"')
  && sourceTeamWorkLog.includes('break_minutes')
  && sourceTeamWorkLog.includes('work_description')
  && sourceTeamWorkLog.includes("saveDraft(TEAM_WORK_LOG_DRAFT_KEY")
  && sourceTeamWorkLog.includes("clearDraft(TEAM_WORK_LOG_DRAFT_KEY")
  && sourceTeamWorkLog.includes('scheduleDraftSave')
  && sourceApp.includes("getDraft('team-work-log')")
  && sourceApp.includes('teamWorkLogModule.restoreDraft')
  && sourceStyles.includes('.team-work-log-entry')
  && sourceStyles.includes('.team-time-select')
  && sourceStyles.includes('.team-member-options')
  && sourceStyles.includes('.team-member-chip')
  && sourceStyles.includes('.autosave-status')
  && read('backend/app/use_cases/common.py').includes('def require_leader')
  && read('backend/app/use_cases/team_work_logs.py').includes('week_start.weekday() != 0')
  && read('backend/app/models.py').includes('class TeamWorkLogEntry')
));

check('normal worker UI is focused and step based', () => (
  sourceIndex.includes('class="card normal-worker-only normal-worker-guide"')
  && sourceIndex.includes('id="attendanceActionHelp"')
  && sourceIndex.includes('data-normal-label="Check in / out"')
  && sourceIndex.includes('data-normal-label="My history"')
  && sourceApp.includes("els.workerView.classList.toggle('normal-worker-mode', isNormalWorker)")
  && sourceApp.includes("element.classList.toggle('access-hidden', !isNormalWorker)")
  && sourceStyles.includes('#workerView.normal-worker-mode .tabs')
  && sourceStyles.includes('#workerView.normal-worker-mode .history-type-filter')
  && sourceStyles.includes('.normal-worker-steps')
  && read('assets/js/worker-attendance.js').includes('Ready. Tap the action you need.')
  && read('assets/js/history.js').includes('Check out when finished')
));

check('worker and supervisor workflow modules are active', () => (
  includesAll(sourceApp, [
    'createWorkerAttendanceModule',
    'createWorkerLogModule',
    'createWorkerFormModule',
    'createWorkerSitesModule',
    'createSupervisorReviewModule',
    'handleSupervisorDecision',
    'handleWorkerEditRecord',
    'syncQueueIfPossible'
  ])
));

check('supervisors can preview work forms', () => (
  sourceIndex.includes('id="workFormsList"')
  && sourceIndex.includes('id="workFormDraftPreview"')
  && sourceIndex.includes('id="workFormPreviewButton"')
  && read('assets/js/staff-sites.js').includes('renderWorkFormFields(preview.querySelector')
  && read('assets/js/staff-sites.js').includes('renderDraftWorkFormPreview')
  && read('assets/js/staff-sites.js').includes('Worker preview')
  && read('assets/css/styles.css').includes('.work-form-preview')
));

check('PDF exports are available for Daywork and submitted forms', () => (
  sourceIndex.includes('value="daywork-pdf"')
  && sourceIndex.includes('value="form-submissions-pdf"')
  && sourceApiClient.includes('/supervisor/form-submissions/export.pdf')
  && sourceApiClient.includes('/supervisor/form-submissions/${submissionId}/export.pdf')
  && read('assets/js/supervisor-review.js').includes('exportSupervisorFormSubmissionsPdf')
  && read('assets/js/history.js').includes('Daywork PDF')
  && read('backend/app/main.py').includes('/supervisor/form-submissions/export.pdf')
  && read('backend/app/use_cases/supervisor_review.py').includes('export_form_submissions_pdf')
));

check('supervisor audit history is wired', () => (
  sourceApiClient.includes('getSupervisorAuditEvents')
  && sourceSupervisorReview.includes('renderAuditHistory')
  && sourceSupervisorReview.includes('auditEventsList')
  && sourceApp.includes('refreshSupervisorAuditHistory')
  && read('backend/app/models.py').includes('class AuditEvent')
  && read('backend/app/main.py').includes('/supervisor/audit-events')
  && read('backend/app/use_cases/audit.py').includes('add_audit_event')
  && read('backend/app/use_cases/audit.py').includes('"actor_access_level"')
  && sourceSupervisorReview.includes('audit-editor-grid')
  && sourceSupervisorReview.includes('actor_department_name')
  && sourceSupervisorReview.includes('actor_access_level')
  && sourceStyles.includes('.audit-editor-grid')
));

check('supervisor location map review is wired', () => (
  sourceApp.includes('createSupervisorMapModule')
  && sourceSupervisorReview.includes('renderLocationMap')
  && sourceSupervisorMap.includes('L.circle(')
  && sourceSupervisorMap.includes('L.polyline(')
  && sourceSupervisorMap.includes('locationMapOutsideOnly')
  && sourceSupervisorMap.includes('onDecision(record')
  && sourceStyles.includes('.location-review-map')
  && sourceWorker.includes("'/assets/js/supervisor-map.js'")
  && viteConfig.includes("'assets/js/supervisor-map.js'")
));

check('site coordinates are rounded and map points stay compact', () => (
  read('assets/js/utils.js').includes('export function roundCoordinate')
  && read('assets/js/staff-sites.js').includes('roundCoordinateInput(els.siteLatitudeInput)')
  && read('assets/js/staff-sites.js').includes('roundCoordinateInput(els.siteLongitudeInput)')
  && sourceWorkerSites.includes('roundCoordinateInput(els.workerSiteLatitudeInput)')
  && sourceWorkerSites.includes('roundCoordinateInput(els.workerSiteLongitudeInput)')
  && sourceIndex.includes('id="siteMap"')
  && sourceIndex.includes('id="siteUseLocationButton"')
  && read('assets/js/staff-sites.js').includes('createSiteMapPicker')
  && sourceSiteMapPicker.includes('L.map(mapElement')
  && sourceSiteMapPicker.includes('draggable: true')
  && sourceSiteMapPicker.includes('L.circle(point')
  && sourceSiteMapPicker.includes('getExistingSites()')
  && sourceStyles.includes('.site-map-picker')
  && sourceWorker.includes("'/assets/js/site-map-picker.js'")
  && viteConfig.includes("'assets/js/site-map-picker.js'")
  && sourceSupervisorMap.includes("radius: record.action === 'check_out' ? 4 : 5")
));

check('dark-mode location toggles are clear and consistently sized', () => (
  sourceStyles.includes('.location-map-filters .location-map-toggle')
  && sourceStyles.includes('flex: 1 1 210px')
  && sourceStyles.includes('color: var(--input-text)')
  && sourceStyles.includes('.location-map-toggle input[type="checkbox"]')
  && sourceStyles.includes('accent-color: var(--brand-blue)')
  && sourceStyles.includes('grid-column: 1 / -1')
));

check('management analytics and reports are wired', () => (
  sourceApp.includes('createSupervisorAnalyticsModule')
  && sourceSupervisorReview.includes('renderManagementAnalytics')
  && sourceSupervisorAnalytics.includes('buildManagementAnalytics')
  && sourceSupervisorAnalytics.includes('Possible duplicate')
  && sourceSupervisorAnalytics.includes('Missing check-out')
  && sourceSupervisorAnalytics.includes('MISSING_CHECK_OUT_GRACE_MS')
  && sourceSupervisorAnalytics.includes('12 * 60 * 60 * 1000')
  && sourceSupervisorAnalytics.includes('buildSiteSummaries')
  && sourceSupervisorAnalytics.includes('buildFormCharts')
  && sourceSupervisorAnalytics.includes('managementCsv')
  && sourceSupervisorAnalytics.includes('managementHtml')
  && sourceStyles.includes('.analytics-trend-chart')
  && sourceStyles.includes('.analytics-response-grid')
  && sourceWorker.includes("'/assets/js/supervisor-analytics.js'")
  && viteConfig.includes("'assets/js/supervisor-analytics.js'")
));

check('supervisors can add audit-logged manual attendance without GPS', () => (
  sourceApiClient.includes('createSupervisorAttendance')
  && sourceApiClient.includes('"/supervisor/records"')
  && sourceSupervisorReview.includes('handleManualAttendanceSubmit')
  && sourceSupervisorReview.includes('renderManualAttendanceSites')
  && sourceSupervisorReview.includes('occurred_at: occurredAt.toISOString()')
  && sourceSupervisorReview.includes('Manual attendance added')
  && read('assets/js/history.js').includes("entrySource === 'supervisor_manual'")
  && read('backend/app/main.py').includes('def create_supervisor_record')
  && read('backend/app/use_cases/supervisor_review.py').includes('create_manual_attendance_record')
  && read('backend/app/use_cases/supervisor_review.py').includes('entry_source="supervisor_manual"')
  && read('backend/app/use_cases/supervisor_review.py').includes('latitude=None')
  && read('backend/smoke_test.py').includes('supervisor creates manual attendance')
  && read('backend/migration_test.py').includes('0006_manual_attendance_entries')
  && sourceStyles.includes('.manual-attendance-form')
));

check('supervisors can submit approved logs for themselves or others', () => (
  sourceApiClient.includes('createSupervisorTaskLog')
  && sourceApiClient.includes('"/supervisor/task-logs"')
  && sourceSupervisorReview.includes('handleAdminTaskLogSubmit')
  && sourceSupervisorReview.includes('renderAdminTaskLogForm')
  && sourceSupervisorReview.includes('String(user.id) === String(state.user?.id)')
  && sourceSupervisorReview.includes('Approved log submitted')
  && read('assets/js/history.js').includes('Admin-entered approved log')
  && read('backend/app/main.py').includes('def create_supervisor_task_log')
  && read('backend/app/use_cases/supervisor_review.py').includes('create_supervisor_task_log')
  && read('backend/app/use_cases/supervisor_review.py').includes('status="approved"')
  && read('backend/app/use_cases/supervisor_review.py').includes('action="task_log_manual_create"')
  && read('backend/smoke_test.py').includes('supervisor creates approved task log for self')
  && read('backend/smoke_test.py').includes('supervisor creates approved task log for another user')
  && read('backend/migration_test.py').includes('0008_manual_task_logs')
  && sourceStyles.includes('.admin-task-log-form')
));

check('rapid duplicate submissions and the 30-day rubbish bin are wired', () => (
  read('backend/app/use_cases/attendance.py').includes('timedelta(seconds=10)')
  && read('backend/app/use_cases/attendance.py').includes('AttendanceRecord.latitude == data.latitude')
  && read('backend/app/use_cases/task_logs.py').includes('timedelta(seconds=10)')
  && read('backend/app/use_cases/record_trash.py').includes('TRASH_RETENTION_DAYS = 30')
  && read('backend/app/use_cases/record_trash.py').includes('run_periodic_trash_purge')
  && read('backend/app/main.py').includes('/supervisor/trash/{record_type}/{record_id}')
  && sourceApiClient.includes('moveSupervisorRecordToTrash')
  && sourceApiClient.includes('restoreSupervisorRecord')
  && sourceSupervisorReview.includes('handleTrashRecord')
  && sourceSupervisorReview.includes('renderTrashList')
  && read('assets/js/history.js').includes('showTrashActions')
  && read('assets/js/history.js').includes('🗑')
  && read('backend/smoke_test.py').includes('dedupe rapid attendance double tap')
  && read('backend/smoke_test.py').includes('supervisor moves attendance to rubbish bin')
  && read('backend/migration_test.py').includes('rubbish bin 30-day purge')
  && sourceStyles.includes('.rubbish-bin-record')
));

check('missing check-outs use a 12-hour grace and pair overnight shifts', () => {
  const now = new Date('2026-06-23T08:00:00.000Z');
  const attendance = (userId, userName, action, createdAt, workDate) => ({
    id: `${userId}-${action}-${createdAt}`,
    type: 'attendance',
    userId,
    userName,
    siteId: userId,
    siteName: `Site ${userId}`,
    action,
    createdAt,
    workDate,
    status: 'approved'
  });
  const report = buildManagementAnalytics([
    attendance(1, 'Recent', 'check_in', '2026-06-22T22:00:01.000Z', '2026-06-22'),
    attendance(2, 'Old', 'check_in', '2026-06-22T20:00:00.000Z', '2026-06-22'),
    attendance(3, 'Overnight', 'check_in', '2026-06-22T23:00:00.000Z', '2026-06-22'),
    attendance(3, 'Overnight', 'check_out', '2026-06-23T07:00:00.000Z', '2026-06-23')
  ], 30, now);
  const missing = report.exceptions.filter(({ category }) => category === 'Missing check-out');
  const orphanCheckOuts = report.exceptions.filter(({ category }) => category === 'Check-out without check-in');
  return (
    missing.length === 1
    && missing[0].userName === 'Old'
    && orphanCheckOuts.length === 0
  );
});

check('department focus and persisted default department are wired', () => (
  sourceApiClient.includes('updateDefaultDepartment')
  && sourceApiClient.includes('"/auth/default-department"')
  && sourceApp.includes('departmentFocusId')
  && sourceSupervisorReview.includes('renderDepartmentFilter')
  && sourceSupervisorReview.includes('departmentFocusedRecords')
  && sourceSupervisorReview.includes('handleSaveDefaultDepartment')
  && sourceSupervisorReview.includes("dashboardDepartmentName || 'All departments'")
  && sourceSupervisorMap.includes('state.departmentFocusId')
  && sourceSupervisorAnalytics.includes('state.departmentFocusId')
  && read('assets/js/staff-sites.js').includes('matchesDepartmentFocus')
  && read('backend/app/main.py').includes('@app.patch("/auth/default-department")')
  && read('backend/smoke_test.py').includes('super admin saves all departments as default')
  && read('backend/migration_test.py').includes('0005_dashboard_department_preference')
));

check('department supervisors cannot resign global admins', () => (
  read('backend/app/use_cases/staff_site_admin.py').includes(
    'Only a global admin can change a global admin account status'
  )
  && read('backend/smoke_test.py').includes(
    'department supervisor cannot resign super admin by status route'
  )
  && read('backend/smoke_test.py').includes(
    'department supervisor cannot resign super admin by user update'
  )
  && read('assets/js/staff-sites.js').includes('statusIsProtected')
  && read('assets/js/staff-sites.js').includes('if (!statusIsProtected)')
));

const failures = [];

for (const item of checks) {
  let passed = false;

  try {
    passed = Boolean(item.test());
  } catch {
    passed = false;
  }

  if (passed) {
    console.log(`ok - ${item.name}`);
  } else {
    failures.push(item.name);
    console.error(`not ok - ${item.name}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} mobile/browser workflow check${failures.length === 1 ? '' : 's'} failed.`);
  process.exit(1);
}

console.log('\nmobile/browser workflow checks passed');
