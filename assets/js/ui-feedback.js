const VALID_TONES = new Set(['info', 'success', 'warning', 'error']);

const ERROR_MESSAGE_PATTERN = /could not|cannot|failed|denied|invalid|expired|is required|must be|required\.|please (?:select|capture|choose|enter)|choose a|enter a|no active|unavailable|not support|does not belong|more than \d+ minutes old|reconnect before/i;
const SUCCESS_MESSAGE_PATTERN = /saved|created|added|updated|submitted|approved|rejected|restored|exported|synced|captured successfully|verified|reactivated|discarded|ready\.?$/i;

function feedbackTone(message, offline, requestedTone) {
  if (VALID_TONES.has(requestedTone)) return requestedTone;
  if (ERROR_MESSAGE_PATTERN.test(message)) return 'error';
  if (offline) return 'warning';
  if (SUCCESS_MESSAGE_PATTERN.test(message)) return 'success';
  return 'info';
}

function asElement(value) {
  if (value instanceof Element) return value;
  if (typeof value === 'string') return document.querySelector(value);
  return null;
}

function mergeDescribedBy(currentValue, nextId) {
  return [...new Set(`${currentValue || ''} ${nextId}`.trim().split(/\s+/).filter(Boolean))].join(' ');
}

export function setButtonBusy(button, isBusy, busyLabel = 'Working...') {
  if (!button) return;

  if (isBusy) {
    if (button.getAttribute('aria-busy') === 'true') return;
    button.dataset.feedbackLabel = button.textContent || '';
    button.dataset.feedbackWasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-busy');
    return;
  }

  if (button.dataset.feedbackLabel !== undefined) {
    button.textContent = button.dataset.feedbackLabel;
  }
  const wasDisabled = button.dataset.feedbackWasDisabled === 'true';
  delete button.dataset.feedbackLabel;
  delete button.dataset.feedbackWasDisabled;
  button.disabled = wasDisabled;
  button.removeAttribute('aria-busy');
  button.classList.remove('is-busy');
}

export function createUiFeedback({
  syncIndicator,
  syncIndicatorText,
  systemBanner,
  toastViewport,
  translateElement = () => {},
  schedule = window.setTimeout.bind(window),
  cancel = window.clearTimeout.bind(window)
}) {
  const toastTimers = new Map();
  const fieldStates = new WeakMap();
  let nextToastId = 0;
  let nextFieldErrorId = 0;

  function setSyncState(syncState, message) {
    if (!syncIndicator) return;
    syncIndicator.dataset.state = syncState || 'idle';
    if (syncIndicatorText) {
      syncIndicatorText.textContent = message;
    } else {
      syncIndicator.textContent = message;
    }
    syncIndicator.hidden = false;
    translateElement(syncIndicator);
  }

  function setBusyButton(button, isBusy, busyLabel) {
    setButtonBusy(button, isBusy, busyLabel);
    if (button) translateElement(button);
  }

  function hideSystemBanner() {
    if (!systemBanner) return;
    systemBanner.textContent = '';
    systemBanner.classList.add('hidden');
    systemBanner.removeAttribute('data-tone');
  }

  function showSystemBanner(message, options = {}) {
    if (!systemBanner || !message) return;
    const tone = feedbackTone(message, options.offline, options.tone);
    systemBanner.textContent = message;
    systemBanner.dataset.tone = tone;
    systemBanner.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    systemBanner.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    systemBanner.classList.remove('hidden');
    translateElement(systemBanner);
  }

  function removeToast(toast) {
    if (!toast) return;
    const timer = toastTimers.get(toast);
    if (timer) cancel(timer);
    toastTimers.delete(toast);
    toast.remove();
  }

  function scheduleToastRemoval(toast, timeout) {
    const existingTimer = toastTimers.get(toast);
    if (existingTimer) cancel(existingTimer);
    if (!timeout) return;
    toastTimers.set(toast, schedule(() => removeToast(toast), timeout));
  }

  function showToast(message, options = {}) {
    if (!toastViewport || !message) return null;
    const tone = feedbackTone(message, options.offline, options.tone);
    const existingToast = [...toastViewport.querySelectorAll('.toast')]
      .find((item) => item.dataset.message === message && item.dataset.tone === tone);
    if (existingToast) {
      scheduleToastRemoval(existingToast, options.timeout ?? (tone === 'error' ? 10000 : 6500));
      return existingToast;
    }

    const toast = document.createElement('article');
    toast.id = `toast-${++nextToastId}`;
    toast.className = 'toast';
    toast.dataset.tone = tone;
    toast.dataset.message = message;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');

    const messageNode = document.createElement('span');
    messageNode.className = 'toast-message';
    messageNode.textContent = message;

    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.className = 'toast-dismiss ghost';
    dismissButton.setAttribute('aria-label', 'Dismiss notification');
    dismissButton.textContent = '\u00d7';
    dismissButton.addEventListener('click', () => removeToast(toast));

    toast.append(messageNode, dismissButton);
    toastViewport.appendChild(toast);
    translateElement(toast);

    while (toastViewport.querySelectorAll('.toast').length > 3) {
      removeToast(toastViewport.querySelector('.toast'));
    }

    scheduleToastRemoval(toast, options.timeout ?? (tone === 'error' ? 10000 : 6500));
    return toast;
  }

  function clearLocal(target) {
    const region = asElement(target);
    if (!region) return;
    region.textContent = '';
    region.classList.add('hidden');
    region.removeAttribute('data-tone');
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
  }

  function showLocal(target, message, options = {}) {
    const region = asElement(target);
    if (!region || !message) return null;
    const tone = feedbackTone(message, options.offline, options.tone);
    region.textContent = message;
    region.dataset.tone = tone;
    region.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    region.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.classList.remove('hidden');
    translateElement(region);
    return region;
  }

  function clearFieldError(fieldValue) {
    const field = asElement(fieldValue);
    if (!field) return;
    const state = fieldStates.get(field);
    if (state) {
      field.removeEventListener('input', state.clearOnEdit);
      field.removeEventListener('change', state.clearOnEdit);
      document.getElementById(state.errorId)?.remove();
      if (state.describedBy) {
        field.setAttribute('aria-describedby', state.describedBy);
      } else {
        field.removeAttribute('aria-describedby');
      }
      fieldStates.delete(field);
    }
    field.removeAttribute('aria-invalid');
  }

  function setFieldError(fieldValue, message, options = {}) {
    const field = asElement(fieldValue);
    if (!field || !message) return null;
    clearFieldError(field);

    const errorId = `${field.id || 'field'}-feedback-error-${++nextFieldErrorId}`;
    const error = document.createElement('small');
    error.id = errorId;
    error.className = 'field-error';
    error.textContent = message;

    const insertionTarget = field.closest('.date-input-shell') || field;
    insertionTarget.insertAdjacentElement('afterend', error);

    const describedBy = field.getAttribute('aria-describedby') || '';
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', mergeDescribedBy(describedBy, errorId));

    const clearOnEdit = () => clearFieldError(field);
    field.addEventListener('input', clearOnEdit);
    field.addEventListener('change', clearOnEdit);
    fieldStates.set(field, { clearOnEdit, describedBy, errorId });

    if (options.focus !== false && typeof field.focus === 'function') {
      field.focus({ preventScroll: true });
      field.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center'
      });
    }
    return error;
  }

  function show(message, offlineOrOptions = false, extraOptions = {}) {
    const legacyOffline = typeof offlineOrOptions === 'boolean' ? offlineOrOptions : false;
    const options = typeof offlineOrOptions === 'object' && offlineOrOptions !== null
      ? { ...offlineOrOptions }
      : { ...extraOptions, offline: legacyOffline };
    const tone = feedbackTone(message, options.offline, options.tone);
    const resolvedOptions = { ...options, tone };

    if (options.field) setFieldError(options.field, message, resolvedOptions);
    if (options.local) return showLocal(options.local, message, resolvedOptions);
    if (options.toast === false) return null;
    return showToast(message, resolvedOptions);
  }

  function bindFormValidation(formValue, localTarget) {
    const form = asElement(formValue);
    if (!form || form.dataset.feedbackValidationBound === 'true') return;
    form.dataset.feedbackValidationBound = 'true';
    form.addEventListener('invalid', (event) => {
      const control = event.target;
      event.preventDefault();
      if (!(control instanceof HTMLElement) || form.querySelector(':invalid') !== control) return;
      const message = control.validationMessage || 'Check this field and try again.';
      show(message, {
        local: localTarget,
        field: control,
        tone: 'error'
      });
    }, true);
  }

  function clearAll() {
    hideSystemBanner();
    toastViewport?.querySelectorAll('.toast').forEach(removeToast);
    document.querySelectorAll('[data-local-feedback]').forEach(clearLocal);
    document.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
  }

  return {
    bindFormValidation,
    clearAll,
    clearFieldError,
    clearLocal,
    hideSystemBanner,
    setButtonBusy: setBusyButton,
    setFieldError,
    setSyncState,
    show,
    showLocal,
    showSystemBanner,
    showToast
  };
}
