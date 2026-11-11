import { probeOfflineStorage } from './db.js';
import { loadWorkerReportTemplateSnapshot } from './offline-report-template-snapshot.js';

export function readinessScope(user) {
  const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  return user?.role === 'worker' && (user.status == null || user.status === 'active')
    && id(user.id) && id(user.departmentId) ? `${Number(user.id)}:${Number(user.departmentId)}` : '';
}

function bounded(operation, timeoutMs) {
  let timer;
  return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Check timed out')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export function checkOfflineShell(serviceWorker = globalThis.navigator?.serviceWorker, timeoutMs = 4000) {
  const controller = serviceWorker?.controller;
  if (!controller || typeof MessageChannel === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (ready) => {
      clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = ({ data }) => finish(serviceWorker.controller === controller
      && data?.type === 'OFFLINE_READINESS_RESULT' && data.ready === true
      && typeof data.cacheVersion === 'string' && data.cacheVersion.startsWith('leader-field-'));
    try { controller.postMessage({ type: 'OFFLINE_READINESS_CHECK' }, [channel.port2]); }
    catch { finish(false); }
  });
}

export async function inspectOfflineReadiness(user, {
  getSavedUser, loadSnapshot = loadWorkerReportTemplateSnapshot,
  probeStorage = probeOfflineStorage, checkShell = checkOfflineShell, timeoutMs = 5000
}) {
  const scope = readinessScope(user);
  const result = { identity: false, templates: false, storage: false, shell: false,
    templateCount: 0, savedAt: '', checkedAt: new Date().toISOString(), ready: false };
  if (!scope) return result;
  try { result.identity = readinessScope(getSavedUser()) === scope; } catch { /* unavailable */ }
  await Promise.all([
    bounded(async () => {
      const snapshot = await loadSnapshot(user);
      return snapshot;
    }, timeoutMs).then((snapshot) => {
      result.templateCount = snapshot?.templates?.length || 0;
      result.savedAt = snapshot?.savedAt || '';
      result.templates = result.templateCount > 0 && Number.isFinite(Date.parse(result.savedAt));
    }).catch(() => {}),
    bounded(probeStorage, timeoutMs).then((ok) => { result.storage = ok === true; }).catch(() => {}),
    bounded(checkShell, timeoutMs).then((ok) => { result.shell = ok === true; }).catch(() => {})
  ]);
  // A second read fences sign-out/account changes in another tab during checks.
  try { result.identity = result.identity && readinessScope(getSavedUser()) === scope; }
  catch { result.identity = false; }
  result.ready = result.identity && result.templates && result.storage && result.shell;
  return result;
}

export function createOfflineReadiness({ panel, button, status, details, getUser, getSavedUser,
  translate = () => {}, formatTime = (value) => value, inspect = inspectOfflineReadiness }) {
  let revision = 0;
  function clear() {
    revision += 1;
    panel.hidden = true;
    button.disabled = false;
    status.textContent = '';
    details.replaceChildren();
    delete panel.dataset.state;
  }
  async function check() {
    const user = getUser();
    const scope = readinessScope(user);
    const run = ++revision;
    if (!scope) { clear(); return; }
    panel.hidden = false;
    panel.dataset.state = 'checking';
    status.textContent = 'Checking offline readiness…';
    details.replaceChildren();
    button.disabled = true;
    translate(panel);
    let result;
    try { result = await inspect(user, { getSavedUser }); }
    catch {
      result = { ready: false, identity: false, templates: false, storage: false, shell: false,
        templateCount: 0, savedAt: '', checkedAt: new Date().toISOString() };
    }
    if (run !== revision) return;
    if (getUser() !== user || readinessScope(getUser()) !== scope) { clear(); return; }
    button.disabled = false;
    panel.dataset.state = result.ready ? 'checked' : 'attention';
    status.textContent = result.ready ? 'Offline checks passed on this device.' : 'Offline readiness is not confirmed.';
    const lines = [
      result.identity ? 'Worker identity saved for this Department.' : 'Saved Worker identity is missing or different. Sign in online.',
      result.templates ? 'Report Templates saved for this Worker and Department.' : 'No usable saved Report Templates. Connect and refresh data.',
      result.storage ? 'Small device storage read/write/delete check passed.' : 'Device storage check failed or timed out. Do not rely on offline saving.',
      result.shell ? 'App files are cached by the active service worker.' : 'Offline app files are not confirmed. Connect, reload, then check again.'
    ];
    for (const line of lines) {
      const item = document.createElement('li'); item.textContent = line; details.append(item);
    }
    const metadata = document.createElement('li');
    const countLabel = document.createElement('span'); countLabel.textContent = 'Saved templates';
    const count = document.createElement('span'); count.setAttribute('data-no-i18n', '');
    count.textContent = `: ${result.templateCount}`;
    metadata.append(countLabel, count);
    if (result.savedAt) {
      const label = document.createElement('span'); label.textContent = 'Last saved';
      const time = document.createElement('time'); time.setAttribute('data-no-i18n', '');
      time.dateTime = result.savedAt; time.textContent = formatTime(result.savedAt);
      metadata.append(document.createTextNode(' · '), label, document.createTextNode(': '), time);
    }
    details.append(metadata);
    const checked = document.createElement('li');
    const label = document.createElement('span'); label.textContent = 'Last checked';
    const time = document.createElement('time'); time.setAttribute('data-no-i18n', '');
    time.dateTime = result.checkedAt; time.textContent = formatTime(result.checkedAt);
    checked.append(label, document.createTextNode(': '), time); details.append(checked);
    translate(panel);
  }
  button.addEventListener('click', () => { void check(); });
  return { check, clear };
}
