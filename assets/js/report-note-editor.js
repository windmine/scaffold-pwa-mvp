import { setTranslatableText } from './i18n.js';
import {
  clearNoteDraft, loadNoteDraft, reportNoteContext, reportNoteDraftKey, saveNoteDraft
} from './report-note-drafts.js';

// This editor owns only a private device draft. The Report workflow remains an
// explicit, online mutation, separate from Worker offline submission replay.
export function createReportNoteEditor({
  state, enabled = false, confirmAction = async () => false,
  validateReport, resolveReport, onResolved = async () => {},
  revealWorkspace = () => {}, canResolve = () => false
}) {
  const ids = ['reportNotePanel', 'reportNoteForm', 'reportNoteIdentity', 'reportResolutionNote',
    'reportNoteStatus', 'reportNoteFeedback', 'closeReportNoteButton', 'discardReportNoteButton',
    'resolveReportNoteButton', 'retryReportNoteSaveButton', 'refreshReportNoteButton', 'reloadReportNoteButton'];
  const doc = typeof document === 'undefined' ? null : document;
  const canReadPanel = enabled && typeof doc?.getElementById === 'function';
  const els = Object.fromEntries(ids.map((id) => [id, canReadPanel ? doc.getElementById(id) : null]));
  const available = Boolean(enabled && ids.every((id) => els[id]));
  const actions = new Map();
  let epoch = 0;
  let active = null;
  let selectedKey = '';
  let navigationLocked = false;
  let openingRequest = 0;
  let bound = false;

  function scope() {
    return JSON.stringify([state.user?.id, state.user?.role, state.user?.departmentId,
      state.user?.isGlobalAdmin === true, state.departmentFocusId || '']);
  }

  function contextFor(record) {
    if (!available || record?.durability !== 'durable') return null;
    return reportNoteContext(state.user, record, state.departmentFocusId || '');
  }

  function isCurrent(entry) {
    if (!entry || active !== entry || entry.epoch !== epoch || entry.scope !== scope()) return false;
    const context = contextFor(entry.record);
    return Boolean(context && reportNoteDraftKey(context) === entry.key);
  }

  function readOnly(entry) {
    return entry.confirmed || entry.finalized || entry.conflict
      || !entry.workflowKnown || entry.record.workflowStatus !== 'in_review';
  }

  function hasUnstoredText(entry) {
    return entry.text !== entry.savedText;
  }

  function blankReadFailure(entry) {
    // A failed initial read has no editable local input to lose. Leaving must
    // not require storage to recover, and must never write over the unknown row.
    return entry.loadFailed && !entry.text && !entry.savedText && !entry.writePromise;
  }

  function isUnsafe(entry) {
    return Boolean(entry && (entry.loading || (entry.loadFailed && !blankReadFailure(entry)) || entry.writePromise
      || entry.busy || hasUnstoredText(entry)));
  }

  function message(entry, text, tone = 'warning') {
    if (!isCurrent(entry)) return;
    entry.feedback = text;
    entry.feedbackTone = text ? tone : '';
    setTranslatableText(els.reportNoteFeedback, text);
    els.reportNoteFeedback.classList.toggle('hidden', !text);
    if (text) els.reportNoteFeedback.dataset.tone = tone;
    else els.reportNoteFeedback.removeAttribute('data-tone');
  }

  function statusText(entry) {
    if (entry.loading) return 'Loading saved note...';
    if (entry.loadFailed) return 'The saved note could not be read. Try loading it again before editing.';
    if (entry.busy === 'resolve') return 'Resolving Report...';
    if (entry.busy === 'validate') return 'Checking the current Report...';
    if (entry.busy === 'discard') return 'Discarding note...';
    if (entry.busy === 'reload') return 'Loading saved note...';
    if (entry.confirmed) return 'Report resolved. This local copy is read-only and will not be submitted again.';
    if (entry.conflict) return 'This note changed in another tab. Your text is kept here; copy it or load the saved note.';
    if (entry.finalized) return 'This note was finalized in another tab. Your local copy is read-only.';
    if (!entry.workflowKnown) return 'This Report is unavailable. Your saved note is kept read-only.';
    if (entry.record.workflowStatus === 'resolved') return 'This Report is already resolved. Your saved note has not replaced the final note.';
    if (entry.record.workflowStatus !== 'in_review') return 'This Report is not in review. Your saved note is read-only.';
    if (entry.saveError) return 'Your note could not be saved. Keep this page open and try again.';
    if (entry.writePromise || hasUnstoredText(entry)) return 'Saving note...';
    if (entry.needsRefresh) return 'Refresh the Report before trying to resolve it again. Your note is kept.';
    if (!navigator.onLine) return 'Private note kept on this device. Reconnect before resolving the Report.';
    return entry.text ? 'Note saved on this device.' : 'Private note draft. Only Resolve report sends it to the Worker.';
  }

  function render(entry = active) {
    if (!available || !isCurrent(entry)) return;
    const locked = Boolean(navigationLocked || entry.busy || entry.loading);
    els.reportNotePanel.hidden = !entry.visible || selectedKey !== entry.key;
    els.reportNoteIdentity.textContent = `${entry.record.formName || 'Report'} · #${entry.context.reportId}`;
    els.reportNoteIdentity.setAttribute('data-no-i18n', '');
    els.reportResolutionNote.disabled = locked || entry.loadFailed;
    els.reportResolutionNote.readOnly = readOnly(entry);
    els.closeReportNoteButton.disabled = locked;
    els.discardReportNoteButton.disabled = locked || entry.loadFailed || entry.finalized || !entry.text;
    els.resolveReportNoteButton.disabled = locked || entry.loadFailed || readOnly(entry)
      || entry.needsRefresh || Boolean(entry.saveError) || !canResolve(entry.record);
    els.retryReportNoteSaveButton.hidden = !entry.saveError || entry.conflict || entry.finalized;
    els.retryReportNoteSaveButton.disabled = locked;
    setTranslatableText(els.retryReportNoteSaveButton, entry.confirmed ? 'Clear saved copy' : 'Try saving again');
    els.refreshReportNoteButton.disabled = locked || !navigator.onLine;
    els.refreshReportNoteButton.hidden = !entry.needsRefresh && entry.workflowKnown
      && entry.record.workflowStatus === 'in_review' && canResolve(entry.record);
    els.reloadReportNoteButton.hidden = !entry.loadFailed && !entry.conflict && !entry.finalized;
    els.reloadReportNoteButton.disabled = locked;
    setTranslatableText(els.reportNoteStatus, statusText(entry));
    setTranslatableText(els.reportNoteFeedback, entry.feedback || '');
    els.reportNoteFeedback.classList.toggle('hidden', !entry.feedback);
    if (entry.feedback) els.reportNoteFeedback.dataset.tone = entry.feedbackTone || 'warning';
    else els.reportNoteFeedback.removeAttribute('data-tone');
    refreshActionLabels();
  }

  function currentAction(item) {
    const context = contextFor(item.record);
    return item.epoch === epoch && item.scope === scope() && item.button.isConnected
      && context && reportNoteDraftKey(context) === item.key;
  }

  function paintAction(item) {
    if (!currentAction(item)) return;
    const local = isCurrent(active) && active.key === item.key ? active : null;
    const hasText = local ? Boolean(local.text) : item.hasText;
    const resolved = item.record.workflowStatus === 'resolved';
    const offline = item.button.dataset.noteReadOnly === 'true';
    item.button.hidden = (resolved || offline) && !hasText;
    setTranslatableText(item.button, resolved ? 'View saved note' : hasText ? 'Continue note' : 'Resolve report');
  }

  function refreshActionLabels() {
    for (const [button, item] of actions) {
      if (!currentAction(item)) { actions.delete(button); continue; }
      paintAction(item);
    }
  }

  function rememberActionText(entry, text) {
    for (const item of actions.values()) {
      if (item.key === entry.key && item.epoch === entry.epoch && item.scope === entry.scope) {
        item.hasText = Boolean(text);
        item.readVersion += 1;
      }
    }
    refreshActionLabels();
  }

  function decorateAction(button, record) {
    const context = contextFor(record);
    if (!context || !['in_review', 'resolved'].includes(record.workflowStatus)) return;
    const item = { button, record: { ...record }, key: reportNoteDraftKey(context),
      epoch, scope: scope(), hasText: false, readVersion: 0 };
    actions.set(button, item);
    paintAction(item);
    void loadNoteDraft(context).then((saved) => {
      if (actions.get(button) !== item || item.readVersion !== 0 || !currentAction(item)) return;
      item.hasText = !saved.deleted && Boolean(saved.text);
      paintAction(item);
    }).catch(() => {
      // Opening an in-review editor retries the read and will not overwrite an
      // unknown saved row. A failed badge read never implies draft deletion.
    });
  }

  function writeFailure(entry, error) {
    entry.saveError = error;
    if (error?.code === 'REPORT_NOTE_CONFLICT') entry.conflict = true;
    if (error?.code === 'REPORT_NOTE_FINALIZED') entry.finalized = true;
    render(entry);
  }

  function flushEntry(entry) {
    if (!entry) return Promise.resolve();
    if (blankReadFailure(entry)) return Promise.resolve();
    if (entry.loading || entry.loadFailed) return Promise.reject(new Error('The saved note has not been loaded safely.'));
    if (entry.writePromise) return entry.writePromise;
    if (!hasUnstoredText(entry)) return Promise.resolve();
    if (entry.conflict || entry.finalized || entry.confirmed) {
      return Promise.reject(new Error('This local note cannot overwrite the saved note.'));
    }
    entry.saveError = null;
    // Capture each input immediately. Writes are serialized per editor and keep
    // its immutable context even if logout clears the UI while storage awaits.
    entry.writePromise = (async () => {
      while (hasUnstoredText(entry)) {
        const text = entry.text;
        const saved = await saveNoteDraft(entry.context, { text, expectedRevision: entry.revision });
        entry.revision = saved.revision;
        entry.savedText = text;
        entry.savedAt = saved.savedAt;
        rememberActionText(entry, text);
      }
    })().catch((error) => {
      writeFailure(entry, error);
      throw error;
    }).finally(() => {
      entry.writePromise = null;
      render(entry);
    });
    render(entry);
    return entry.writePromise;
  }

  function flushNoteDraft() {
    if (!available || !isCurrent(active)) return Promise.resolve();
    return flushEntry(active);
  }

  async function loadEntry(entry) {
    entry.loading = true;
    entry.loadFailed = false;
    render(entry);
    try {
      const saved = await loadNoteDraft(entry.context);
      if (!isCurrent(entry)) return false;
      entry.revision = saved.revision;
      entry.text = saved.deleted ? '' : saved.text;
      entry.savedText = entry.text;
      entry.savedAt = saved.savedAt;
      entry.finalized = saved.finalized;
      entry.conflict = false;
      entry.saveError = null;
      els.reportResolutionNote.value = entry.text;
      rememberActionText(entry, entry.text);
      return true;
    } catch {
      if (isCurrent(entry)) entry.loadFailed = true;
      return false;
    } finally {
      entry.loading = false;
      render(entry);
    }
  }

  async function open(record) {
    if (active && !isCurrent(active)) resetSession();
    const context = contextFor(record);
    if (!context || !['in_review', 'resolved'].includes(record.workflowStatus) || navigationLocked) return false;
    const key = reportNoteDraftKey(context);
    const capturedScope = scope();
    const capturedEpoch = epoch;
    const request = ++openingRequest;
    if (isCurrent(active) && active.key === key) {
      selectedKey = key;
      active.visible = true;
      active.record = { ...record };
      render();
      focusNoteEditor();
      return true;
    }
    const previous = active;
    if (previous) {
      if (previous.busy || previous.loading) { focusNoteEditor(); return false; }
      previous.busy = 'save';
      render(previous);
      try { await flushEntry(previous); }
      catch {
        if (isCurrent(previous)) {
          message(previous, 'Keep this note open until it is saved, or explicitly discard it.');
          focusNoteEditor();
        }
        return false;
      } finally {
        previous.busy = '';
        render(previous);
      }
    }
    if (capturedEpoch !== epoch || capturedScope !== scope() || request !== openingRequest) return false;
    const entry = { context, key, record: { ...record }, epoch, scope: capturedScope, visible: true,
      text: '', savedText: '', revision: 0, savedAt: '', loading: true, loadFailed: false,
      writePromise: null, saveError: null, conflict: false, finalized: false, confirmed: false,
      workflowKnown: true, needsRefresh: false, busy: '', feedback: '' };
    active = entry;
    selectedKey = key;
    els.reportResolutionNote.value = '';
    render(entry);
    revealWorkspace();
    await loadEntry(entry);
    if (isCurrent(entry) && entry.visible && selectedKey === entry.key) focusNoteEditor();
    return isCurrent(entry) && !entry.loadFailed;
  }

  function setSelection(record) {
    if (!available) return;
    const context = contextFor(record);
    selectedKey = context ? reportNoteDraftKey(context) : '';
    if (active && !isCurrent(active)) { resetSession(); return; }
    if (active && active.key !== selectedKey) active.visible = false;
    render();
  }

  function updateRecords(records) {
    if (!available) return;
    if (active && !isCurrent(active)) { resetSession(); return; }
    if (active) {
      const current = records.find((record) => {
        const context = contextFor(record);
        return context && reportNoteDraftKey(context) === active.key;
      });
      // Missing from a filter or page is not evidence of deletion. A known
      // resolved copy, however, can immediately disable an old resolve editor.
      if (current) active.record = { ...current };
      render();
    }
    refreshActionLabels();
  }

  function focusNoteEditor() {
    if (!available || !isCurrent(active)) return;
    const entry = active;
    selectedKey = entry.key;
    entry.visible = true;
    revealWorkspace();
    render(entry);
    els.reportNotePanel.scrollIntoView({ block: 'nearest' });
    if (!els.reportResolutionNote.disabled) els.reportResolutionNote.focus({ preventScroll: true });
  }

  async function close() {
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading) return;
    entry.busy = 'save';
    render(entry);
    try {
      await flushEntry(entry);
      if (!isCurrent(entry)) return;
      entry.visible = false;
      message(entry, '');
    } catch {
      message(entry, 'Your note is not saved yet. Keep this page open and try again.');
    } finally {
      entry.busy = '';
      render(entry);
    }
  }

  async function discard() {
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading || entry.loadFailed) return;
    entry.busy = 'confirm';
    render(entry);
    try {
      if (!await confirmAction({ title: 'Discard saved note?',
        message: 'This removes your private note draft from this device. The Report and its final note will not change.',
        confirmLabel: 'Discard note', tone: 'danger' }) || !isCurrent(entry)) return;
      entry.busy = 'discard';
      render(entry);
      // A failed write leaves its original revision intact. CAS still protects
      // newer work in another tab; explicit discard cannot erase that work.
      await entry.writePromise?.catch(() => {});
      if (!isCurrent(entry)) return;
      const saved = await clearNoteDraft(entry.context, { expectedRevision: entry.revision,
        finalized: entry.confirmed || entry.record.workflowStatus === 'resolved' });
      entry.revision = saved.revision;
      entry.text = '';
      entry.savedText = '';
      rememberActionText(entry, '');
      if (!isCurrent(entry)) return;
      active = null;
      clearPanel();
    } catch (error) {
      writeFailure(entry, error);
      message(entry, 'The saved note could not be discarded. Your text is still here.');
    } finally {
      entry.busy = '';
      render(entry);
    }
  }

  async function reloadSaved() {
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading) return;
    entry.busy = 'reload';
    render(entry);
    try {
      if (entry.text && !await confirmAction({ title: 'Load the saved note?',
        message: 'This replaces the text currently in this editor. Copy anything you want to keep first.',
        confirmLabel: 'Load saved note' })) return;
      if (!isCurrent(entry)) return;
      await entry.writePromise?.catch(() => {});
      if (!isCurrent(entry)) return;
      await loadEntry(entry);
      if (isCurrent(entry)) message(entry, '');
    } finally {
      entry.busy = '';
      render(entry);
    }
  }

  async function checkCurrentReport(entry) {
    const record = await validateReport(entry.record);
    if (!isCurrent(entry)) return false;
    const context = contextFor(record);
    if (!context || reportNoteDraftKey(context) !== entry.key) throw new Error('The Report is outside the current scope.');
    entry.record = { ...record };
    entry.workflowKnown = true;
    return true;
  }

  async function refreshReport() {
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading || !navigator.onLine) return;
    entry.busy = 'validate';
    render(entry);
    try {
      await flushEntry(entry);
      if (!isCurrent(entry)) return;
      if (!await checkCurrentReport(entry)) return;
      entry.needsRefresh = false;
      message(entry, entry.record.workflowStatus === 'in_review'
        ? 'Report refreshed. Review your note before resolving.'
        : 'The Report can no longer be resolved here. Your saved note is kept.');
    } catch {
      if (isCurrent(entry)) {
        entry.workflowKnown = false;
        entry.needsRefresh = true;
        message(entry, 'Could not verify the current Report. Your note is kept; try Refresh Report again.');
      }
    } finally {
      entry.busy = '';
      render(entry);
    }
  }

  async function finalize(entry) {
    const saved = await clearNoteDraft(entry.context, { expectedRevision: entry.submittedRevision, finalized: true });
    entry.revision = saved.revision;
    entry.text = '';
    entry.savedText = '';
    entry.finalized = true;
    entry.saveError = null;
    rememberActionText(entry, '');
    if (!isCurrent(entry)) return;
    active = null;
    clearPanel();
  }

  async function submit(event) {
    event.preventDefault();
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading || entry.loadFailed
      || readOnly(entry) || entry.needsRefresh || !canResolve(entry.record)) return;
    if (!entry.text.trim()) {
      message(entry, 'A resolution note is required.', 'error');
      els.reportResolutionNote.focus();
      els.reportResolutionNote.reportValidity();
      return;
    }
    entry.busy = 'validate';
    message(entry, '');
    render(entry);
    let posted = false;
    try {
      await flushEntry(entry);
      if (!isCurrent(entry)) return;
      if (!await checkCurrentReport(entry)) return;
      if (entry.record.workflowStatus !== 'in_review' || !canResolve(entry.record)) {
        message(entry, 'The Report can no longer be resolved here. Your saved note is kept.');
        return;
      }
      // A tab may have changed or discarded a previously saved note even when
      // this editor has no dirty text. Recheck its revision before the POST.
      try {
        const saved = await saveNoteDraft(entry.context, { text: entry.text, expectedRevision: entry.revision });
        entry.revision = saved.revision;
        entry.savedText = entry.text;
        entry.savedAt = saved.savedAt;
      } catch (error) {
        writeFailure(entry, error);
        throw error;
      }
      if (!isCurrent(entry) || entry.record.workflowStatus !== 'in_review' || !canResolve(entry.record)) return;
      entry.busy = 'resolve';
      entry.submittedRevision = entry.revision;
      render(entry);
      try {
        await resolveReport(entry.record, entry.text.trim());
        // Record acknowledgement independently of refresh and device cleanup.
        // Never offer the POST again after the server has confirmed success.
        posted = true;
        entry.confirmed = true;
        entry.record = { ...entry.record, workflowStatus: 'resolved' };
      } catch (error) {
        entry.needsRefresh = true;
        if (isCurrent(entry)) message(entry, 'The resolution could not be confirmed. Your note is kept. Refresh Report before trying again.');
        throw error;
      }
      try { await finalize(entry); }
      catch (error) {
        writeFailure(entry, error);
        message(entry, 'Report resolved, but this local copy could not be cleared. It is read-only; do not submit it again.');
      }
      if (entry.epoch !== epoch || entry.scope !== scope()) return;
      try { await onResolved(entry.record); }
      catch {
        message(entry, 'Report resolved. The Report list could not refresh; refresh it when connected.');
      }
    } catch {
      if (!posted && isCurrent(entry) && !entry.needsRefresh) {
        message(entry, entry.saveError
          ? 'Your note is not saved yet. Keep this page open and try again.'
          : 'Could not verify the current Report. Your note is kept; try Refresh Report again.');
        if (!entry.saveError) { entry.workflowKnown = false; entry.needsRefresh = true; }
      }
    } finally {
      entry.busy = '';
      render(entry);
    }
  }

  async function retrySave() {
    const entry = active;
    if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading) return;
    entry.busy = 'save';
    render(entry);
    try {
      if (entry.confirmed) await finalize(entry);
      else await flushEntry(entry);
      message(entry, '');
    } catch (error) { writeFailure(entry, error); }
    finally { entry.busy = ''; render(entry); }
  }

  async function prepareForNavigation() {
    if (!available || !isCurrent(active)) return { safe: true };
    const entry = active;
    if (navigationLocked || entry.busy || entry.loading || (entry.loadFailed && !blankReadFailure(entry))) {
      return { safe: false, workspace: 'review', message: 'Wait until the Report note is saved before leaving or updating.' };
    }
    navigationLocked = true;
    render(entry);
    try {
      await flushEntry(entry);
      if (!isCurrent(entry)) { navigationLocked = false; return { safe: false, workspace: 'review', message: 'The Report note session changed. Try again.' }; }
      return { safe: true };
    } catch {
      navigationLocked = false;
      render(entry);
      return { safe: false, workspace: 'review', message: 'Your Report note is not saved on this device. Keep this page open and try again before leaving or updating.' };
    }
  }

  function cancelNavigationPreparation() {
    navigationLocked = false;
    render();
  }

  function clearPanel() {
    if (!available) return;
    els.reportNotePanel.hidden = true;
    els.reportResolutionNote.value = '';
    els.reportResolutionNote.disabled = true;
    els.reportNoteIdentity.textContent = '';
    setTranslatableText(els.reportNoteStatus, '');
    setTranslatableText(els.reportNoteFeedback, '');
    els.reportNoteFeedback.classList.add('hidden');
    els.reportNoteFeedback.removeAttribute('data-tone');
    refreshActionLabels();
  }

  function resetSession() {
    epoch += 1;
    openingRequest += 1;
    active = null;
    selectedKey = '';
    navigationLocked = false;
    actions.clear();
    clearPanel();
  }

  function bindEvents() {
    if (!available || bound) return;
    bound = true;
    els.reportResolutionNote.addEventListener('input', () => {
      const entry = active;
      if (!isCurrent(entry) || navigationLocked || entry.busy || entry.loading || entry.loadFailed || readOnly(entry)) return;
      entry.text = els.reportResolutionNote.value;
      entry.feedback = '';
      render(entry);
      void flushEntry(entry).catch(() => {});
    });
    els.reportNoteForm.addEventListener('submit', submit);
    els.closeReportNoteButton.addEventListener('click', close);
    els.discardReportNoteButton.addEventListener('click', discard);
    els.retryReportNoteSaveButton.addEventListener('click', retrySave);
    els.refreshReportNoteButton.addEventListener('click', refreshReport);
    els.reloadReportNoteButton.addEventListener('click', reloadSaved);
    window.addEventListener('beforeunload', (event) => {
      if (!isCurrent(active) || !isUnsafe(active)) return;
      event.preventDefault();
      event.returnValue = '';
    });
    const flushVisibleInput = () => { void flushNoteDraft().catch(() => {}); };
    window.addEventListener('pagehide', flushVisibleInput);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushVisibleInput();
    });
    window.addEventListener('online', () => render());
    window.addEventListener('offline', () => render());
    clearPanel();
  }

  return { bindEvents, open, setSelection, updateRecords, decorateAction, prepareForNavigation,
    cancelNavigationPreparation, flushNoteDraft, focusNoteEditor, resetSession,
    hasActiveNote: () => Boolean(available && isCurrent(active)) };
}
