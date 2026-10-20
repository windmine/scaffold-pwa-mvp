import { setTranslatableText, translateText } from './i18n.js';
import { formatDateTime } from './utils.js';

export function invitationEmailStatusText(status) {
  return {
    accepted: 'Invitation email accepted by the mail server. Delivery is not confirmed.',
    failed: 'Email was not sent. Copy or share this link privately, or create a new link in Staff to try email again.',
    unknown: 'Email acceptance is unconfirmed. Do not send again. Check with the Worker or share the same link privately.'
  }[status] || '';
}

export function createWorkerInvitationDialog(els, { sendInvitationEmail } = {}) {
  let opener = null;
  let generation = 0;
  let shareIdentity = '';
  let sharing = false;
  let mode = 'invitation';
  let currentContext = () => true;
  let emailContext = null;
  let emailSending = false;

  function updateEmailButton() {
    if (!els.sendWorkerInvitationEmailButton) return;
    els.sendWorkerInvitationEmailButton.hidden = mode === 'recovery' || !emailContext || !sendInvitationEmail;
    els.sendWorkerInvitationEmailButton.disabled = emailSending || Boolean(emailContext?.attempted);
  }

  function setDialogCopy(nextMode) {
    const recovery = nextMode === 'recovery';
    const copy = {
      workerInvitationTitle: recovery ? 'Worker recovery link ready' : 'Worker invitation ready',
      workerInvitationHelp: recovery
        ? 'Verify this Worker’s identity before sharing privately. Anyone with this link can choose a new password for this account. No email has been sent.'
        : "Send an invitation email to the Worker shown above, or share this link privately. Anyone with it can set this account's password.",
      workerInvitationLinkLabel: recovery ? 'Private recovery link' : 'Private setup link',
      workerInvitationLinkNotice: recovery
        ? 'The current password stays unchanged until this link is used. The link is shown only now; closing this window hides it.'
        : 'The link is shown only now. Closing this window hides it; create a new link from Staff if needed.'
    };
    for (const [key, value] of Object.entries(copy)) {
      if (els[key]) setTranslatableText(els[key], value);
    }
  }

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
    emailContext = null;
    if (els.workerInvitationEmailStatus) els.workerInvitationEmailStatus.textContent = '';
    mode = 'invitation';
    currentContext = () => true;
    els.workerInvitationLink.value = '';
    els.workerInvitationIdentity.textContent = '';
    els.workerInvitationExpiry.textContent = '';
    els.workerInvitationStatus.textContent = '';
    els.copyWorkerInvitationButton.disabled = false;
    updateShareButton();
    updateEmailButton();
    if (els.workerInvitationDialog.open) els.workerInvitationDialog.close();
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }

  function show(result, focusTarget, { mode: nextMode = 'invitation', isCurrent = () => true } = {}) {
    clear();
    if (!isCurrent()) return;
    const recovery = nextMode === 'recovery';
    if (typeof result?.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(result.token)
      || typeof result.user?.name !== 'string' || typeof result.user?.email !== 'string'
      || !Number.isFinite(Date.parse(result.expires_at))
      || (recovery && result.delivery_method !== 'manual')) {
      throw new Error(recovery
        ? 'The recovery link is unavailable. Refresh Staff and create a new link.'
        : 'The account was created, but its invitation link is unavailable. Refresh Staff and create a new link.');
    }
    mode = recovery ? 'recovery' : 'invitation';
    currentContext = isCurrent;
    setDialogCopy(mode);
    const url = new URL(recovery ? '/recover-password.html' : '/setup-password.html', window.location.origin);
    url.hash = `token=${result.token}`;
    els.workerInvitationLink.value = url.href;
    els.workerInvitationIdentity.textContent = `${result.user.name} — ${result.user.email}`;
    shareIdentity = `${result.user.name} (${result.user.email})`;
    els.workerInvitationExpiry.textContent = formatDateTime(result.expires_at);
    const validId = (value) => Number.isSafeInteger(value) && value > 0;
    if (!recovery && validId(result.user.id) && validId(result.user.invitation_id)) {
      emailContext = { userId: result.user.id, invitationId: result.user.invitation_id,
        recipient: result.user.email, token: result.token, attempted: Boolean(result.user.invitation_email_attempted_at) };
      if (els.workerInvitationEmailStatus) setTranslatableText(els.workerInvitationEmailStatus,
        invitationEmailStatusText(result.user.invitation_email_status) || 'No email has been sent.');
    }
    updateEmailButton();
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
  els.sendWorkerInvitationEmailButton?.addEventListener('click', async () => {
    if (!currentContext()) { clear(); return; }
    if (!els.workerInvitationDialog.open || mode !== 'invitation' || !emailContext
      || !sendInvitationEmail || emailSending || emailContext.attempted) return;
    const requestGeneration = generation;
    const context = emailContext;
    const isCurrent = () => requestGeneration === generation && context === emailContext && currentContext();
    emailSending = true;
    context.attempted = true;
    updateEmailButton();
    setTranslatableText(els.workerInvitationEmailStatus, 'Sending invitation email. Closing this window will not cancel it.');
    try {
      const result = await sendInvitationEmail(context.userId, context.token);
      if (!isCurrent()) return;
      if (result?.user_id !== context.userId || result.invitation_id !== context.invitationId
        || result.recipient !== context.recipient || !['accepted', 'failed', 'unknown'].includes(result.email_status)) {
        throw new Error('Unconfirmed invitation email response');
      }
      setTranslatableText(els.workerInvitationEmailStatus, invitationEmailStatusText(result.email_status));
    } catch (error) {
      if (!isCurrent()) return;
      if (error?.code === 'INVITATION_EMAIL_UNAVAILABLE') {
        context.attempted = false; // Server rejected configuration before claiming or sending.
        setTranslatableText(els.workerInvitationEmailStatus, 'Invitation email is unavailable. Copy or share the private link.');
      } else if (error?.status >= 400 && error.status < 500) {
        setTranslatableText(els.workerInvitationEmailStatus, 'The email request was rejected. Refresh Staff before making another change.');
      } else {
        setTranslatableText(els.workerInvitationEmailStatus, invitationEmailStatusText('unknown'));
      }
    } finally {
      emailSending = false;
      if (requestGeneration === generation && !currentContext()) clear();
      updateEmailButton();
    }
  });
  window.addEventListener('pagehide', () => clear());
  els.workerInvitationDialog.addEventListener('close', () => {
    if (!els.workerInvitationDialog.open) clear();
  });
  els.workerInvitationDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    clear({ restoreFocus: true });
  });
  els.shareWorkerInvitationButton.addEventListener('click', async () => {
    if (!currentContext()) { clear(); return; }
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
        title: translateText(mode === 'recovery' ? 'ReportFlow password recovery' : 'ReportFlow invitation'),
        text: translateText(mode === 'recovery'
          ? 'Private recovery link for {identity}. Open it to choose your new password.'
          : 'Private setup link for {identity}. Open it to choose your password.')
          .replace('{identity}', shareIdentity),
        url
      });
      if (requestGeneration === generation && currentContext()) {
        setTranslatableText(els.workerInvitationStatus, 'Sharing finished. Confirm the intended Worker received the link.');
      }
    } catch (error) {
      if (requestGeneration === generation && currentContext()) {
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
      if (requestGeneration === generation && !currentContext()) clear();
      updateShareButton();
    }
  });
  els.copyWorkerInvitationButton.addEventListener('click', async () => {
    if (!currentContext()) { clear(); return; }
    const url = els.workerInvitationLink.value;
    if (!url || !els.workerInvitationDialog.open || els.copyWorkerInvitationButton.disabled) return;
    const requestGeneration = generation;
    els.copyWorkerInvitationButton.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (requestGeneration === generation && currentContext()) {
        setTranslatableText(els.workerInvitationStatus, 'Link copied. Share it privately with this Worker.');
      }
    } catch {
      if (requestGeneration === generation && currentContext()) {
        els.workerInvitationLink.focus();
        els.workerInvitationLink.select();
        setTranslatableText(els.workerInvitationStatus, 'Copy is unavailable. Select and copy the link above.');
      }
    } finally {
      if (requestGeneration === generation && !currentContext()) clear();
      if (requestGeneration === generation) els.copyWorkerInvitationButton.disabled = false;
    }
  });

  return { show, clear };
}
