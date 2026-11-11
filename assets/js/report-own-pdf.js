import { exportMyReportPdf, getSession } from './api-client.js';
import { setTranslatableText } from './i18n.js';
import { reportSubmissionState } from './report-status.js';

export function canDownloadOwnReport(record, user) {
  return user?.role === 'worker' && user.status !== 'resigned'
    && record.type === 'form' && record.submissionPurpose === 'report'
    && reportSubmissionState(record).key === 'submitted'
    && String(record.userId) === String(user.id)
    && record.departmentId != null && user.departmentId != null
    && String(record.departmentId) === String(user.departmentId);
}

// PDFs live only in this open card's memory, never in device drafts or caches.
// A slow fetch can consume the native share gesture. Keep the prepared file for
// one minute and require a new tap when activation has expired.
export function mountOwnReportPdfActions(container, { record, isCurrent, onSessionExpired }) {
  const group = document.createElement('div');
  group.className = 'report-own-pdf-actions';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Report PDF actions');
  const download = document.createElement('button');
  const share = document.createElement('button');
  for (const [button, label] of [[download, 'Download PDF'], [share, 'Share PDF']]) {
    button.type = 'button';
    button.className = 'secondary';
    setTranslatableText(button, label);
  }
  const status = document.createElement('p');
  status.className = 'report-own-pdf-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  group.append(download, share, status);
  container.append(group);
  let disposed = false;
  let pending = false;
  let prepared = null;
  let expiresAt = 0;
  let expiry;
  let controller;
  const downloads = new Map();
  const sameAccount = () => {
    const user = getSession();
    return user?.role === 'worker' && user.status !== 'resigned'
      && String(user.id) === String(record.userId)
      && String(user.departmentId) === String(record.departmentId);
  };
  const current = () => !disposed && sameAccount() && isCurrent();
  const tell = (text) => { if (current()) setTranslatableText(status, text); };
  const forget = () => { prepared = null; expiresAt = 0; clearTimeout(expiry); };
  const busy = (value) => {
    pending = value;
    download.disabled = share.disabled = value;
    group.setAttribute('aria-busy', String(value));
  };
  function save(blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `report-${record.backendRecordId}.pdf`;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60_000));
  }
  function canShare(file) {
    try {
      return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
    } catch { return false; }
  }
  async function shareFile(file) {
    // No await before this call: it must use the current button's gesture.
    try {
      await navigator.share({ files: [file] });
      tell('Sharing finished. Delivery to the recipient is not confirmed.');
      forget();
    } catch (error) {
      if (error?.name === 'AbortError') tell('Sharing cancelled.');
      else tell('Sharing is unavailable. Use Download PDF, then share the saved file.');
      // Never download automatically after cancellation or a failed chooser.
    }
  }
  async function run(mode) {
    if (!current() || pending) return;
    if (navigator.onLine === false) {
      forget();
      tell('You are offline. Connect to download or share this Report PDF.');
      return;
    }
    if (prepared && Date.now() >= expiresAt) forget();
    busy(true);
    try {
      if (mode === 'share' && prepared) {
        await shareFile(prepared);
        return;
      }
      forget();
      tell('Preparing PDF...');
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 60_000);
      let blob;
      try { blob = await exportMyReportPdf(record.backendRecordId, { signal: controller.signal }); }
      finally { clearTimeout(timeout); controller = null; }
      if (!current()) return;
      if (navigator.onLine === false) { offline(); return; }
      if (mode === 'download') {
        save(blob);
        tell('PDF download started. Check your downloads.');
        return;
      }
      const file = typeof File === 'function'
        ? new File([blob], `report-${record.backendRecordId}.pdf`, { type: 'application/pdf' }) : null;
      if (!file || !canShare(file)) {
        save(blob);
        tell('File sharing is not supported here. PDF download started instead.');
        return;
      }
      prepared = file;
      expiresAt = Date.now() + 60_000;
      expiry = setTimeout(() => {
        forget();
        if (!pending) tell('Prepared PDF expired. Tap Share PDF to prepare it again.');
      }, 60_000);
      if (navigator.userActivation?.isActive) await shareFile(file);
      else tell('PDF ready. Tap Share PDF again to choose an app.');
    } catch (error) {
      if (!current()) return;
      forget();
      if (error?.status === 401) {
        tell('Your session expired. Sign in again to download this PDF.');
        onSessionExpired?.(error);
      } else if ([403, 404].includes(error?.status)) {
        tell('This Report PDF is unavailable. Refresh My Reports and try again.');
      } else if (error?.status === 409) {
        tell('This Report PDF cannot be prepared safely. Contact your Supervisor.');
      } else if (navigator.onLine === false) {
        tell('You are offline. Connect to download or share this Report PDF.');
      } else {
        tell('PDF could not be prepared. Check your connection and try again.');
      }
    } finally { if (!disposed) { busy(false); if (!sameAccount()) download.disabled = share.disabled = true; } }
  }
  const offline = () => {
    forget();
    controller?.abort();
    tell('You are offline. Connect to download or share this Report PDF.');
  };
  const accountChanged = (event) => {
    if (event.key !== null && event.key !== 'geo_user') return;
    if (sameAccount()) return;
    // Other tabs share authentication but not history state. Clear prepared
    // bytes immediately instead of allowing this tab's stale user to share.
    forget();
    controller?.abort();
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.clear();
    download.disabled = share.disabled = true;
    setTranslatableText(status, 'Your account changed. Refresh My Reports before downloading or sharing.');
  };
  window.addEventListener('storage', accountChanged);
  window.addEventListener('offline', offline);
  download.addEventListener('click', () => run('download'));
  share.addEventListener('click', () => run('share'));
  if (navigator.onLine === false) offline();
  return () => {
    disposed = true;
    forget();
    controller?.abort();
    window.removeEventListener('offline', offline);
    window.removeEventListener('storage', accountChanged);
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.clear();
    group.remove();
  };
}
