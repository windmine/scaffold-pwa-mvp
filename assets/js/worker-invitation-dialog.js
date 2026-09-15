import { setTranslatableText } from './i18n.js';
import { formatDateTime } from './utils.js';

export function createWorkerInvitationDialog(els) {
  let opener = null;
  let generation = 0;

  function clear({ restoreFocus = false } = {}) {
    generation += 1;
    const target = opener;
    opener = null;
    els.workerInvitationLink.value = '';
    els.workerInvitationIdentity.textContent = '';
    els.workerInvitationExpiry.textContent = '';
    els.workerInvitationStatus.textContent = '';
    els.copyWorkerInvitationButton.disabled = false;
    if (els.workerInvitationDialog.open) els.workerInvitationDialog.close();
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }

  function show(result, focusTarget) {
    clear();
    if (typeof result?.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(result.token)
      || typeof result.user?.name !== 'string' || typeof result.user?.email !== 'string'
      || !Number.isFinite(Date.parse(result.expires_at))) {
      throw new Error('The account was created, but its invitation link is unavailable. Refresh Staff and create a new link.');
    }
    const url = new URL('/setup-password.html', window.location.origin);
    url.hash = `token=${result.token}`;
    els.workerInvitationLink.value = url.href;
    els.workerInvitationIdentity.textContent = `${result.user.name} — ${result.user.email}`;
    els.workerInvitationExpiry.textContent = formatDateTime(result.expires_at);
    opener = focusTarget;
    try {
      els.workerInvitationDialog.showModal();
    } catch (error) {
      clear();
      throw error;
    }
    els.copyWorkerInvitationButton.focus();
  }

  els.closeWorkerInvitationButton.addEventListener('click', () => clear({ restoreFocus: true }));
  window.addEventListener('pagehide', () => clear());
  els.workerInvitationDialog.addEventListener('close', () => {
    if (!els.workerInvitationDialog.open) clear();
  });
  els.workerInvitationDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    clear({ restoreFocus: true });
  });
  els.copyWorkerInvitationButton.addEventListener('click', async () => {
    const url = els.workerInvitationLink.value;
    if (!url || els.copyWorkerInvitationButton.disabled) return;
    const requestGeneration = generation;
    els.copyWorkerInvitationButton.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (requestGeneration === generation) {
        setTranslatableText(els.workerInvitationStatus, 'Link copied. Share it privately with this Worker.');
      }
    } catch {
      if (requestGeneration === generation) {
        els.workerInvitationLink.focus();
        els.workerInvitationLink.select();
        setTranslatableText(els.workerInvitationStatus, 'Copy is unavailable. Select and copy the link above.');
      }
    } finally {
      if (requestGeneration === generation) els.copyWorkerInvitationButton.disabled = false;
    }
  });

  return { show, clear };
}
