import { initLanguageToggle, setTranslatableText } from './i18n.js';

// A fragment never reaches the server. Keep its capability in memory only and
// remove it before making any API request or changing the page's content.
let token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
window.history.replaceState(null, '', window.location.pathname);
const form = document.getElementById('setupPasswordForm');
const passwordInput = document.getElementById('setupPasswordInput');
const confirmationInput = document.getElementById('setupPasswordConfirmInput');
const button = document.getElementById('setupPasswordButton');
const retryButton = document.getElementById('setupPasswordRetryButton');
const status = document.getElementById('setupPasswordStatus');
const identity = document.getElementById('setupInvitationIdentity');
const continuationHelp = document.getElementById('setupContinuationHelp');
let busy = false;
let generation = 0;
let invitationEmail = '';

function canContinueOnThisBrowser() {
  try {
    // A saved/offline identity also owns unfinished work. Do not switch it from
    // this separate setup page, even if its server session has expired.
    return localStorage.getItem('geo_user') === null
      && !document.cookie.split(';').some((part) => /^geo_csrf_token=/.test(part.trim()));
  } catch {
    return false;
  }
}

function explainContinuation(message) {
  setTranslatableText(continuationHelp, message);
  continuationHelp.hidden = false;
}

initLanguageToggle({ button: document.getElementById('setupLanguageButton') });

function showStatus(message, error = false) {
  setTranslatableText(status, message);
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
}

function setBusy(value) {
  busy = value;
  button.disabled = value;
  passwordInput.disabled = value;
  confirmationInput.disabled = value;
  retryButton.disabled = value;
  form.setAttribute('aria-busy', String(value));
  setTranslatableText(button, value ? 'Setting password...'
    : canContinueOnThisBrowser() ? 'Set password and continue' : 'Set password');
}

function invalidInvitation(error) {
  return error.status === 400 && error.message.startsWith('This invitation is invalid or expired.');
}

async function invitationRequest(action, body) {
  let response;
  try {
    response = await fetch(`/api/auth/worker-invitations/${action}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Cannot connect. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : 'Could not complete password setup. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function inspectInvitation() {
  if (busy) return;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    token = '';
    showStatus('Open the complete private setup link from your supervisor.', true);
    return;
  }
  const currentGeneration = generation;
  setBusy(true);
  retryButton.hidden = true;
  showStatus('Checking invitation...');
  try {
    const invitation = await invitationRequest('inspect', { token });
    if (currentGeneration !== generation) return;
    invitationEmail = invitation.email;
    identity.textContent = `${invitation.name} — ${invitation.email} — ${invitation.department_name}`;
    form.hidden = false;
    showStatus('Your supervisor will not see your password.');
    if (!canContinueOnThisBrowser()) explainContinuation('This browser may already have an account or saved work. Password setup will not switch accounts.');
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (invalidInvitation(error)) token = '';
    showStatus(error.message, true);
    retryButton.hidden = Boolean(error.status && error.status < 500 && error.status !== 429);
  } finally {
    if (currentGeneration === generation) setBusy(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !token) return;
  if (passwordInput.value !== confirmationInput.value) {
    showStatus('Passwords do not match.', true);
    confirmationInput.focus();
    return;
  }
  if (new TextEncoder().encode(passwordInput.value).length > 72) {
    showStatus('Password must be at most 72 UTF-8 bytes.', true);
    passwordInput.focus();
    return;
  }
  const currentGeneration = generation;
  const shouldContinue = canContinueOnThisBrowser();
  let newPassword = passwordInput.value;
  const email = invitationEmail;
  setBusy(true);
  showStatus('Setting password...');
  try {
    await invitationRequest('accept', { token, password: newPassword });
    if (currentGeneration !== generation) return;
    token = '';
    passwordInput.value = '';
    confirmationInput.value = '';
    form.hidden = true;
    identity.textContent = '';
    showStatus('Password set. You can now sign in to ReportFlow.');
    if (shouldContinue && canContinueOnThisBrowser()) {
      // Use ordinary password authentication, not the invitation capability.
      // The backend refuses to replace any cookie/header session on this path.
      // No password or invitation token is put in storage, a URL or a log.
      showStatus('Password set. Signing you in...');
      try {
        const response = await fetch('/api/auth/login/after-setup', {
          method: 'POST', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: newPassword, only_if_signed_out: true })
        });
        newPassword = '';
        const data = await response.json().catch(() => ({}));
        if (currentGeneration !== generation) return;
        // Our own successful login sets the CSRF cookie. Only the saved identity
        // is rechecked here; another page must not have its identity overwritten.
        if (!response.ok || !data.user || data.user.email !== email) {
          showStatus('Password set. You can now sign in to ReportFlow.');
          explainContinuation(response.status === 409
            ? 'An existing browser session was left unchanged. Open the app and sign out there before using this account.'
            : 'Your password is saved, but sign-in could not finish. Use Sign in to ReportFlow below.');
          return;
        }
        if (localStorage.getItem('geo_user') !== null) {
          showStatus('Password set. You can now sign in to ReportFlow.');
          explainContinuation('Another page changed the active account. Open the app to check your session before continuing.');
          return;
        }
        const { saveSession } = await import('./api-client.js');
        if (currentGeneration !== generation) return;
        if (localStorage.getItem('geo_user') !== null) {
          showStatus('Password set. You can now sign in to ReportFlow.');
          explainContinuation('Another page changed the active account. Open the app to check your session before continuing.');
          return;
        }
        saveSession(data.user);
        window.location.replace('/index.html');
      } catch {
        if (currentGeneration !== generation) return;
        showStatus('Password set. You can now sign in to ReportFlow.');
        explainContinuation('Your password is saved, but sign-in could not finish. Use Sign in to ReportFlow below.');
      }
    } else {
      explainContinuation('Open the app to continue with its current account, or sign out there before using your new account.');
    }
  } catch (error) {
    if (currentGeneration === generation) {
      if (invalidInvitation(error)) {
        token = '';
        passwordInput.value = '';
        confirmationInput.value = '';
        identity.textContent = '';
        form.hidden = true;
        showStatus('This invitation is invalid or expired. If you just set a password, try signing in; otherwise ask your supervisor for a new link.', true);
      } else {
        showStatus(error.message, true);
      }
    }
  } finally {
    // Drop the remaining local reference even on a failed/stale request.
    // eslint-disable-next-line no-useless-assignment
    newPassword = '';
    if (currentGeneration === generation) setBusy(false);
  }
});
retryButton.addEventListener('click', () => { void inspectInvitation(); });
window.addEventListener('hashchange', () => {
  // A replacement link can be opened in this same tab without a full navigation.
  // Retire the prior request before inspecting the new capability.
  generation += 1;
  token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  window.history.replaceState(null, '', window.location.pathname);
  passwordInput.value = '';
  confirmationInput.value = '';
  identity.textContent = '';
  invitationEmail = '';
  continuationHelp.hidden = true;
  continuationHelp.textContent = '';
  form.hidden = true;
  retryButton.hidden = true;
  setBusy(false);
  void inspectInvitation();
});
window.addEventListener('pagehide', () => {
  generation += 1;
  token = '';
  passwordInput.value = '';
  confirmationInput.value = '';
  identity.textContent = '';
  invitationEmail = '';
  continuationHelp.hidden = true;
  continuationHelp.textContent = '';
  form.hidden = true;
  retryButton.hidden = true;
  showStatus('Open the complete private setup link from your supervisor.', true);
});
void inspectInvitation();
