import { setTranslatableText } from './i18n.js';

const VALID_TONES = new Set(['default', 'danger']);

function canRestoreFocus(element) {
  return element instanceof HTMLElement
    && element.isConnected
    && !element.hidden
    && !element.closest('[hidden], [inert]')
    && element.getClientRects().length > 0;
}

export function createConfirmationDialog({
  dialog,
  title,
  description,
  confirmButton,
  cancelButton,
  translateElement = () => {}
}) {
  let activeRequest = null;

  function restoreFocus(element) {
    if (!canRestoreFocus(element)) return;
    element.focus({ preventScroll: true });
  }

  function settle(confirmed, { restore = true } = {}) {
    if (!activeRequest) return;

    const request = activeRequest;
    activeRequest = null;
    if (dialog.open) dialog.close(confirmed ? 'confirm' : 'cancel');
    if (restore) restoreFocus(request.invoker);
    request.resolve(confirmed);
  }

  function cancel({ restoreFocus: shouldRestoreFocus = true } = {}) {
    settle(false, { restore: shouldRestoreFocus });
  }

  confirmButton.addEventListener('click', () => settle(true));
  cancelButton.addEventListener('click', () => cancel());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open) cancel();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outsideDialog = event.clientX < bounds.left
      || event.clientX > bounds.right
      || event.clientY < bounds.top
      || event.clientY > bounds.bottom;
    if (outsideDialog) cancel();
  });

  function confirm({
    title: titleText = 'Confirm action',
    message = 'Review the details before continuing.',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'default'
  } = {}) {
    if (activeRequest) return Promise.resolve(false);

    const invoker = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setTranslatableText(title, titleText);
    setTranslatableText(description, message);
    setTranslatableText(confirmButton, confirmLabel);
    setTranslatableText(cancelButton, cancelLabel);
    dialog.dataset.tone = VALID_TONES.has(tone) ? tone : 'default';
    confirmButton.dataset.tone = dialog.dataset.tone;
    translateElement(dialog);

    let resolveRequest;
    const promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    activeRequest = { invoker, resolve: resolveRequest };
    try {
      dialog.showModal();
    } catch {
      activeRequest = null;
      restoreFocus(invoker);
      resolveRequest(false);
      return promise;
    }
    window.requestAnimationFrame(() => cancelButton.focus({ preventScroll: true }));
    return promise;
  }

  return {
    cancel,
    confirm,
    isOpen: () => Boolean(activeRequest && dialog.open)
  };
}
