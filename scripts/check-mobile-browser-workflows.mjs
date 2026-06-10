import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const sourceWorker = read('sw.js');
const sourceOfflineQueue = read('assets/js/offline-submissions.js');
const sourceWorkFormFields = read('assets/js/work-form-fields.js');
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
  'dist/assets/icons/leader-logo.svg',
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
  && distIndex.includes('href="/assets/icons/leader-icon.svg"')
  && distIndex.includes('href="/assets/icons/apple-touch-icon.png"')
));

[
  'statusBanner',
  'installButton',
  'downloadAppButton',
  'updateButton',
  'loginForm',
  'registerForm',
  'workerView',
  'supervisorView',
  'attendanceSite',
  'captureLocationButton',
  'checkInButton',
  'checkOutButton',
  'taskForm',
  'workFormSubmissionForm',
  'reviewQueueList',
  'auditEventsList',
  'refreshAuditButton'
].forEach((id) => {
  check(`#${id} exists in the app shell`, () => sourceIndex.includes(`id="${id}"`));
});

check('mobile viewport and camera/photo controls exist', () => (
  sourceIndex.includes('name="viewport"')
  && sourceIndex.includes('capture="environment"')
  && sourceIndex.includes('id="taskPhoto" type="file" accept="image/*" multiple')
  && sourceIndex.includes('id="workFormPhotos" type="file" accept="image/*" multiple')
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

check('worker and supervisor workflow modules are active', () => (
  includesAll(sourceApp, [
    'createWorkerAttendanceModule',
    'createWorkerLogModule',
    'createWorkerFormModule',
    'createSupervisorReviewModule',
    'handleSupervisorDecision',
    'handleWorkerEditRecord',
    'syncQueueIfPossible'
  ])
));

check('supervisor audit history is wired', () => (
  sourceApiClient.includes('getSupervisorAuditEvents')
  && sourceSupervisorReview.includes('renderAuditHistory')
  && sourceSupervisorReview.includes('auditEventsList')
  && sourceApp.includes('refreshSupervisorAuditHistory')
  && read('backend/app/models.py').includes('class AuditEvent')
  && read('backend/app/main.py').includes('/supervisor/audit-events')
  && read('backend/app/use_cases/audit.py').includes('add_audit_event')
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
