import { initLanguageToggle, setTranslatableText } from './i18n.js';

// The capability stays in memory. Strip both fragment and any unrelated query
// before inspecting it; never place this token or a password in device storage.
let token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
window.history.replaceState(null, '', window.location.pathname);
const form = document.getElementById('recoveryPasswordForm');
const passwordInput = document.getElementById('recoveryPasswordInput');
const confirmationInput = document.getElementById('recoveryPasswordConfirmInput');
const button = document.getElementById('recoveryPasswordButton');
const retryButton = document.getElementById('recoveryPasswordRetryButton');
const status = document.getElementById('recoveryPasswordStatus');
const identity = document.getElementById('recoveryIdentity');
const expiry = document.getElementById('recoveryExpiry');
const expiryTime = document.getElementById('recoveryExpiryTime');
const sessionHelp = document.getElementById('recoverySessionHelp');
const pendingRequests = new Set();
let busy = false;
let inspected = false;
let generation = 0;

try {
  const theme = localStorage.getItem('leader-theme');
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme)
    ? theme : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
} catch {
  // Password recovery still works when device storage is unavailable.
}
initLanguageToggle({ button: document.getElementById('recoveryLanguageButton') });

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
  setTranslatableText(button, value ? 'Resetting password...' : 'Reset password');
}

function showSessionHelp(message) {
  setTranslatableText(sessionHelp, message);
  sessionHelp.hidden = false;
}

function clearPrivateFields() {
  inspected = false;
  passwordInput.value = '';
  confirmationInput.value = '';
  identity.textContent = '';
  expiryTime.textContent = '';
  expiryTime.removeAttribute('datetime');
  expiry.hidden = true;
  form.hidden = true;
}

function invalidLink() {
  token = '';
  clearPrivateFields();
  retryButton.hidden = true;
  showStatus('This recovery link is invalid or expired. If you just reset your password, try signing in; otherwise ask your supervisor for a new link.', true);
}

async function recoveryRequest(action, body) {
  const controller = new AbortController();
  pendingRequests.add(controller);
  try {
    let response;
    try {
      response = await fetch(`/api/auth/worker-password-recovery/${action}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
    } catch {
      const error = new Error('Cannot connect. Check your connection and try again.');
      error.status = 0;
      throw error;
    }
    // Server validation may echo submitted inputs. Only fixed client messages
    // are presented on failure, never raw password/token-bearing response data.
    if (!response.ok) {
      const error = new Error('Could not reset your password. Try again.');
      error.status = response.status;
      throw error;
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Cannot connect. Check your connection and try again.');
    return data;
  } finally {
    pendingRequests.delete(controller);
  }
}

function retryMessage(error, accepting = false) {
  if (error.status === 429) return 'Too many attempts. Wait a little before trying again.';
  if (error.status === 422) return 'Check your new password. Use at least 8 characters, up to 72 UTF-8 bytes.';
  if (accepting) return 'We could not confirm whether your password changed. Try signing in with the new password first. If it does not work, retry here or ask your supervisor for a new link.';
  return 'Cannot connect. Check your connection and try again.';
}

function isInvalidLink(error) {
  return [400, 404, 409, 410].includes(error.status);
}

async function inspectRecovery() {
  if (busy) return;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    token = '';
    clearPrivateFields();
    showStatus('Open the complete private recovery link from your supervisor.', true);
    return;
  }
  const currentGeneration = generation;
  setBusy(true);
  retryButton.hidden = true;
  showStatus('Checking recovery link...');
  try {
    const recovery = await recoveryRequest('inspect', { token });
    if (currentGeneration !== generation) return;
    if (![recovery.name, recovery.email, recovery.department_name].every((value) => typeof value === 'string')) {
      throw new Error('Cannot connect. Check your connection and try again.');
    }
    identity.textContent = `${recovery.name} — ${recovery.email} — ${recovery.department_name}`;
    const expiresAt = new Date(recovery.expires_at);
    if (!Number.isNaN(expiresAt.getTime())) {
      expiryTime.dateTime = expiresAt.toISOString();
      expiryTime.textContent = expiresAt.toLocaleString();
      expiry.hidden = false;
    }
    inspected = true;
    form.hidden = false;
    showStatus('Your supervisor will not see your password.');
    showSessionHelp('Resetting this password signs out this Worker’s existing sessions. It does not switch this browser’s account or delete saved drafts.');
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (isInvalidLink(error)) invalidLink();
    else {
      showStatus(retryMessage(error), true);
      retryButton.hidden = false;
    }
  } finally {
    if (currentGeneration === generation) setBusy(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !token || !inspected || form.hidden) return;
  if (Array.from(passwordInput.value).length < 8) {
    showStatus('Password must be at least 8 characters.', true);
    passwordInput.focus();
    return;
  }
  if (new TextEncoder().encode(passwordInput.value).length > 72) {
    showStatus('Password must be at most 72 UTF-8 bytes.', true);
    passwordInput.focus();
    return;
  }
  if (passwordInput.value !== confirmationInput.value) {
    showStatus('Passwords do not match.', true);
    confirmationInput.focus();
    return;
  }
  const currentGeneration = generation;
  setBusy(true);
  retryButton.hidden = true;
  showStatus('Resetting password...');
  try {
    await recoveryRequest('accept', { token, password: passwordInput.value });
    if (currentGeneration !== generation) return;
    token = '';
    clearPrivateFields();
    showStatus('Password reset. You can now sign in to ReportFlow.');
    // Recovery intentionally never calls login/logout or changes cookies,
    // saved identities, drafts or queues, including on a shared device.
    showSessionHelp('This Worker’s old sessions are signed out. Any other account in this browser is unchanged. Open the app and sign out there before switching accounts; saved drafts are kept.');
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (isInvalidLink(error)) invalidLink();
    else showStatus(retryMessage(error, true), true);
  } finally {
    if (currentGeneration === generation) setBusy(false);
  }
});

function retirePage() {
  generation += 1;
  for (const request of pendingRequests) request.abort();
  pendingRequests.clear();
  token = '';
  clearPrivateFields();
  sessionHelp.hidden = true;
  sessionHelp.textContent = '';
  retryButton.hidden = true;
  setBusy(false);
}

retryButton.addEventListener('click', () => { void inspectRecovery(); });
window.addEventListener('hashchange', () => {
  const replacement = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  window.history.replaceState(null, '', window.location.pathname);
  retirePage();
  token = replacement;
  void inspectRecovery();
});
window.addEventListener('pagehide', () => {
  retirePage();
  showStatus('Open the complete private recovery link from your supervisor.', true);
});
void inspectRecovery();
