import { setTranslatableText, translateText } from './i18n.js';
import { formatDateTime } from './utils.js';

export function createWorkerInvitationDialog(els) {
  let opener = null;
  let generation = 0;
  let shareIdentity = '';
  let sharing = false;

  function updateShareButton() {
    els.shareWorkerInvitationButton.hidden = typeof navigator.share !== 'function';
    els.shareWorkerInvitationButton.disabled = sharing;
    els.copyWorkerInvitationButton.classList.toggle('secondary', !els.shareWorkerInvitationButton.hidden);
  }

  updateShareButton();

  function clear({ restoreFocus = false } = {}) {
    generation += 1;
    const target = opener;
    opener = null;
    shareIdentity = '';
    els.workerInvitationLink.value = '';
    els.workerInvitationIdentity.textContent = '';
    els.workerInvitationExpiry.textContent = '';
    els.workerInvitationStatus.textContent = '';
    els.copyWorkerInvitationButton.disabled = false;
    updateShareButton();
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
    shareIdentity = `${result.user.name} (${result.user.email})`;
    els.workerInvitationExpiry.textContent = formatDateTime(result.expires_at);
    opener = focusTarget;
    try {
      els.workerInvitationDialog.showModal();
    } catch (error) {
      clear();
      throw error;
    }
    (!els.shareWorkerInvitationButton.hidden && !sharing
      ? els.shareWorkerInvitationButton : els.copyWorkerInvitationButton).focus();
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
  els.shareWorkerInvitationButton.addEventListener('click', async () => {
    const url = els.workerInvitationLink.value;
    if (!url || !els.workerInvitationDialog.open || sharing) return;
    const requestGeneration = generation;
    sharing = true;
    updateShareButton();
    els.workerInvitationStatus.textContent = '';
    try {
      if (typeof navigator.share !== 'function') throw new Error('Sharing unavailable');
      // Invoke directly within the click handler: the native chooser requires
      // this user gesture. Never preselect a recipient or send automatically.
      await navigator.share({
        title: translateText('ReportFlow invitation'),
        text: translateText('Private setup link for {identity}. Open it to choose your password.')
          .replace('{identity}', shareIdentity),
        url
      });
      if (requestGeneration === generation) {
        setTranslatableText(els.workerInvitationStatus, 'Sharing finished. Confirm the intended Worker received the link.');
      }
    } catch (error) {
      if (requestGeneration === generation) {
        if (error?.name === 'AbortError') {
          setTranslatableText(els.workerInvitationStatus, 'Sharing cancelled.');
        } else {
          setTranslatableText(els.workerInvitationStatus, 'Sharing is unavailable. Copy the link and send it privately.');
          els.copyWorkerInvitationButton.focus();
        }
      }
    } finally {
      // A still-open native chooser remains single-flight even if the private
      // dialog was cleared/replaced. Its result never updates another invite.
      sharing = false;
      updateShareButton();
    }
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
