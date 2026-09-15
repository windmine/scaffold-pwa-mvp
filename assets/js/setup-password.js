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
let busy = false;
let generation = 0;

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
  setTranslatableText(button, value ? 'Setting password...' : 'Set password');
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
    identity.textContent = `${invitation.name} — ${invitation.email} — ${invitation.department_name}`;
    form.hidden = false;
    showStatus('Choose a password that only you know.');
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
  setBusy(true);
  showStatus('Setting password...');
  try {
    await invitationRequest('accept', { token, password: passwordInput.value });
    if (currentGeneration !== generation) return;
    token = '';
    passwordInput.value = '';
    confirmationInput.value = '';
    form.hidden = true;
    identity.textContent = '';
    showStatus('Password set. You can now sign in to ReportFlow.');
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
  form.hidden = true;
  retryButton.hidden = true;
  showStatus('Open the complete private setup link from your supervisor.', true);
});
void inspectInvitation();
