const DATE_INPUT_SELECTOR = 'input[type="date"]';

function renderDateInput(input) {
  const shell = input.closest('.date-input-shell');
  const display = shell?.querySelector('.date-input-display');
  if (!display) return;

  display.textContent = input.value || '-';
  shell.classList.toggle('is-empty', !input.value);
}

function enhanceDateInput(input) {
  if (!(input instanceof HTMLInputElement) || input.dataset.dateInputEnhanced === 'true') return;

  const shell = document.createElement('span');
  shell.className = 'date-input-shell';

  const display = document.createElement('span');
  display.className = 'date-input-display';
  display.setAttribute('aria-hidden', 'true');

  input.dataset.dateInputEnhanced = 'true';
  input.parentNode.insertBefore(shell, input);
  shell.append(display, input);

  input.addEventListener('input', () => renderDateInput(input));
  input.addEventListener('change', () => renderDateInput(input));
  renderDateInput(input);
}

function enhanceDateInputs(root) {
  if (root instanceof HTMLInputElement && root.matches(DATE_INPUT_SELECTOR)) {
    enhanceDateInput(root);
    return;
  }

  root.querySelectorAll?.(DATE_INPUT_SELECTOR).forEach(enhanceDateInput);
}

function renderDateInputs(root) {
  if (root instanceof HTMLInputElement && root.matches(DATE_INPUT_SELECTOR)) {
    renderDateInput(root);
    return;
  }

  root.querySelectorAll?.(DATE_INPUT_SELECTOR).forEach(renderDateInput);
}

export function setDateInputValue(input, value) {
  if (!input) return;
  enhanceDateInput(input);
  input.value = value || '';
  renderDateInput(input);
}

export function initDateInputs(root = document) {
  enhanceDateInputs(root);

  document.addEventListener('reset', (event) => {
    window.setTimeout(() => renderDateInputs(event.target), 0);
  });

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceDateInputs(node);
      });
    });
  });

  observer.observe(root === document ? document.body : root, {
    childList: true,
    subtree: true
  });
}
