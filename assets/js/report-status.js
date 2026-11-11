// Receipt language is deliberately separate from replay state and email routing.
// A queued POST may have reached the server before its response was lost.
export function reportSubmissionState(record = {}) {
  if (record.isDraftRecovery) return { key: 'saved_draft', label: 'Saved on this device' };
  if (Number.isSafeInteger(Number(record.backendRecordId)) && Number(record.backendRecordId) > 0
      && (record.syncStatus === 'synced' || record.source === 'backend')) {
    return { key: 'submitted', label: 'Submitted' };
  }
  if (record.syncStatus === 'syncing') return { key: 'syncing', label: 'Syncing' };
  if (record.syncStatus === 'queued') return { key: 'queued', label: 'Waiting to sync' };
  return { key: 'saved_draft', label: 'Saved on this device' };
}

export function reportSelfEmailStatus(delivery) {
  // Never read or format recipient fields, even if a mixed-version server sends them.
  if (delivery?.status === 'pending') return 'Your PDF email is waiting to be sent. The Report is submitted.';
  if (delivery?.status === 'accepted') return 'Your PDF email was accepted by the mail server. Inbox delivery is unconfirmed.';
  if (delivery?.status === 'failed') return 'Your PDF email could not be sent. The Report is submitted; contact your Supervisor.';
  if (delivery?.status === 'uncertain') return 'Your PDF email result is unconfirmed. Do not submit again; check your inbox or contact your Supervisor.';
  return 'Your PDF email status is unavailable. This does not change the submitted Report.';
}

export function reportSubmissionReceipt(record = {}) {
  const state = reportSubmissionState(record);
  if (state.key === 'submitted') return reportSelfEmailStatus(record.pdfEmailSelf);
  if (state.key === 'syncing') return 'Uploading your report. Server submission and email are not yet confirmed.';
  if (state.key === 'queued') return 'Saved on this device. Waiting to sync. Server submission and email are not yet confirmed. Keep the app open when online.';
  return 'Saved copy. Open details to recover your answers and evidence.';
}
