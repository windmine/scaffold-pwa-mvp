import { setTranslatableText, setTranslatableAttribute } from './i18n.js';

// Preserve account identity and email together: an address later reassigned to
// another account must not silently retarget an offline recipient selection.
export function reportEmailOptions(template) {
  const value = template?.pdf_email_options;
  if (!value || !Number.isSafeInteger(value.version) || value.version < 1
    || !Array.isArray(value.recipients) || !Array.isArray(value.default_recipients)) return null;
  if (value.source != null && value.source !== 'department_users') return null;
  if (value.source === 'department_users') {
    const emails = new Set(value.recipients);
    const userEmails = new Set(Array.isArray(value.recipient_users) ? value.recipient_users.map((user) => user?.email) : []);
    if (!Array.isArray(value.recipient_users) || !Number.isSafeInteger(value.max_selected_recipients)
      || value.max_selected_recipients < 1
      || value.recipient_users.some((user) => !Number.isSafeInteger(user?.user_id) || user.user_id < 1
        || typeof user.email !== 'string' || !emails.has(user.email))
      || value.recipients.some((email) => !userEmails.has(email))
      || new Set(value.recipient_users.map((user) => user.user_id)).size !== value.recipient_users.length
      || emails.size !== value.recipients.length || userEmails.size !== value.recipient_users.length
      || emails.size !== value.recipient_users.length) return null;
    return { version: value.version, enabled: value.enabled === true, source: value.source,
      recipients: [...value.recipients], default_recipients: [...value.default_recipients],
      recipient_users: value.recipient_users.map(({ user_id, email, name }) => ({ user_id, email, ...(typeof name === 'string' ? { name } : {}) })),
      max_selected_recipients: value.max_selected_recipients,
      default_recipient_unavailable: value.default_recipient_unavailable === true };
  }
  return { version: value.version, enabled: value.enabled === true,
    recipients: [...value.recipients], default_recipients: [...value.default_recipients] };
}

function binding(options, email) {
  const user = options?.recipient_users?.find((user) => user.email === email);
  return user ? { user_id: user.user_id, email: user.email } : null;
}

function selectedAccountAvailable(options, selection, email) {
  if (!options?.recipients.includes(email)) return false;
  if (options.source !== 'department_users') return options.enabled;
  const current = binding(options, email);
  return selection.pdfEmailRecipientUsers?.some((user) => user.email === email && user.user_id === current?.user_id);
}

export function reportEmailSelection(options, saved) {
  if (Array.isArray(saved?.pdfEmailRecipients)) return {
    pdfEmailRecipients: [...saved.pdfEmailRecipients], expectedPdfEmailVersion: saved.expectedPdfEmailVersion ?? null,
    ...(Array.isArray(saved.pdfEmailRecipientUsers) ? { pdfEmailRecipientUsers: structuredClone(saved.pdfEmailRecipientUsers) } : {})
  };
  if (!options) return {};
  const recipients = options.enabled ? [...options.default_recipients] : [];
  return { pdfEmailRecipients: recipients, expectedPdfEmailVersion: options.version,
    ...(options.source === 'department_users' ? { pdfEmailRecipientUsers: recipients.map((email) => binding(options, email)).filter(Boolean) } : {}) };
}

export function reportEmailSelectionStale(options, selection) {
  if (!Array.isArray(selection.pdfEmailRecipients)) return false;
  if (!options) return true;
  return Boolean(selection.pdfEmailRecipients.length && (selection.expectedPdfEmailVersion !== options.version
    || selection.pdfEmailRecipients.length > (options.max_selected_recipients || 20)
    || selection.pdfEmailRecipients.some((email) => !selectedAccountAvailable(options, selection, email))));
}

let pickerId = 0;

export function mountReportEmailRecipients(container, template, email, saved, onChange = () => {}) {
  let options = reportEmailOptions(template);
  let optionsRequired = template?.pdf_email_options != null || saved?.pdfEmailOptionsUnavailable === true;
  let optionsUnavailable = optionsRequired && !options;
  let selection = reportEmailSelection(options, saved);
  let expanded = false;
  let query = '';
  let selectedOnly = false;
  const document = container.ownerDocument;
  const id = 'report-email-picker-' + ++pickerId;
  const node = document.createElement('fieldset');
  node.className = 'report-email-recipients';
  node.dataset.reportEmailRecipients = '';
  const submit = container.querySelector('#submitWorkFormButton');
  const before = submit?.closest('.work-form-submit-row') || submit;
  container.insertBefore(node, before?.parentElement === container ? before : null);
  function element(tag, text, className = '', parent = node) {
    const child = document.createElement(tag);
    child.className = className;
    if (text) setTranslatableText(child, text);
    parent?.append(child);
    return child;
  }
  function person(address, parent) {
    const user = options?.recipient_users?.find((user) => user.email === address);
    const details = element('span', '', 'report-email-person', parent);
    details.dataset.noI18n = '';
    const name = element('strong', '', '', details);
    name.textContent = user?.name?.trim() || address;
    if (user?.name?.trim()) element('span', '', 'report-email-address', details).textContent = address;
    return details;
  }
  function button(text, className, parent = node) {
    const control = element('button', text, className, parent);
    control.type = 'button';
    return control;
  }
  function draw() {
    node.replaceChildren();
    node.hidden = !optionsUnavailable && !options && !Array.isArray(selection.pdfEmailRecipients);
    if (node.hidden) return;
    element('legend', 'PDF email copies');
    const self = element('div', '', 'report-email-self');
    const selfText = element('div', '', 'report-email-person', self);
    element('strong', 'Your PDF copy', '', selfText);
    const account = element('span', '', 'report-email-address', selfText);
    if (email) { account.textContent = email; account.dataset.noI18n = ''; }
    else setTranslatableText(account, 'Your account email');
    element('span', 'Always included', 'report-email-included', self);
    if (optionsUnavailable || reportEmailSelectionStale(options, selection)) {
      const warning = element('p', options
        ? 'Department recipients changed. Your previous selection is kept below. Review the current list before submitting.'
        : 'Recipient options are unavailable. Connect and refresh Templates before submitting this saved Report.', 'report-email-warning');
      warning.setAttribute('role', 'alert');
      const previous = element('p');
      element('span', 'Previous additional copies', '', previous);
      const addresses = element('span', '', '', previous); addresses.dataset.noI18n = '';
      addresses.textContent = ': ' + (selection.pdfEmailRecipients?.join(', ') || 'None');
      if (!options) return;
      element('p', 'Reviewing keeps only the same eligible accounts and email addresses. Unavailable selections are removed; no replacement recipients are selected.', 'field-help');
      const review = button('Review updated recipients', 'secondary');
      review.addEventListener('click', () => {
        const recipients = selection.pdfEmailRecipients.filter((email) => selectedAccountAvailable(options, selection, email));
        selection = { pdfEmailRecipients: recipients, expectedPdfEmailVersion: options.version,
          ...(options.source === 'department_users' ? { pdfEmailRecipientUsers: recipients.map((email) => binding(options, email)) } : {}) };
        expanded = true; query = ''; selectedOnly = false;
        draw(); node.querySelector('[data-recipient-toggle]')?.focus(); onChange();
      });
      return;
    }
    const limit = options?.max_selected_recipients || 20;
    const available = options?.source === 'department_users' || options?.enabled ? options.recipients : [];
    const heading = element('div', '', 'report-email-heading');
    element('strong', 'Additional recipients', '', heading).id = id + '-heading';
    const total = element('span', '', 'report-email-count', heading);
    total.setAttribute('role', 'status'); total.setAttribute('aria-atomic', 'true');
    const selectedSummary = element('ul', '', 'report-email-selected');
    const onlySelf = element('p', 'Only your automatic copy.', 'field-help');
    const more = button('View all selected people', 'secondary report-email-more');
    const toggle = button('Choose people', 'secondary report-email-toggle');
    toggle.dataset.recipientToggle = '';
    toggle.id = id + '-toggle'; toggle.setAttribute('aria-controls', id + '-panel');
    const panel = element('div', '', 'report-email-panel');
    panel.id = id + '-panel';
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-labelledby', id + '-heading');
    element('p', 'Choose people in this Template’s Department. Selections update immediately.', 'field-help', panel);
    const searchLabel = element('label', 'Find a person', 'report-email-search', panel);
    const search = element('input', '', '', searchLabel);
    search.type = 'search'; search.value = query; search.autocomplete = 'off';
    setTranslatableAttribute(search, 'placeholder', 'Search name or email');
    const filters = element('div', '', 'report-email-filters', panel);
    const all = button('All people', 'secondary', filters);
    const selected = button('Selected people', 'secondary', filters);
    const results = element('span', '', 'report-email-results', filters);
    results.setAttribute('role', 'status'); results.setAttribute('aria-atomic', 'true');
    const limitNote = element('p', 'Limit reached. Remove someone to choose another person.', 'field-help report-email-warning', panel);
    const list = element('div', '', 'report-email-list', panel);
    const empty = element('p', 'No matching people. Try a different name or email.', 'field-help', panel);
    const choices = [];
    const footer = element('div', '', 'report-email-footer', panel);
    const clear = button('Clear additional recipients', 'secondary', footer);
    const done = button('Done', '', footer);
    element('p', 'Only active accounts that have completed account setup are listed.', 'field-help', panel);
    if (!available.length) element('p', 'No eligible additional recipients are available in this Department.', 'field-help');
    if (options?.default_recipient_unavailable) element('p', 'The previous default recipient is unavailable. No replacement was selected. Review your choices before submitting.', 'field-help report-email-warning');
    element('p', 'Email is queued after this Report syncs. Inbox delivery is not guaranteed.', 'field-help report-email-delivery');

    function open(value) {
      expanded = value; panel.hidden = !value;
      toggle.setAttribute('aria-expanded', String(value));
      setTranslatableText(toggle, value ? 'Close people picker' : selection.pdfEmailRecipients.length ? 'Edit people' : 'Choose people');
    }
    function filter() {
      const needle = query.trim().toLocaleLowerCase();
      let count = 0;
      for (const { input, label, address, name } of choices) {
        label.hidden = Boolean((selectedOnly && !input.checked) || (needle && !(name + ' ' + address).toLocaleLowerCase().includes(needle)));
        if (!label.hidden) count += 1;
      }
      all.setAttribute('aria-pressed', String(!selectedOnly));
      selected.setAttribute('aria-pressed', String(selectedOnly));
      empty.hidden = count > 0;
      setTranslatableText(empty, query.trim() ? 'No matching people. Try a different name or email.' : 'No additional recipients selected.');
      results.replaceChildren();
      element('span', 'Showing', '', results);
      element('span', '', '', results).textContent = ' ' + count;
    }
    function choose(address, checked) {
      if (checked && selection.pdfEmailRecipients.length >= limit) return;
      selection.expectedPdfEmailVersion = options.version;
      selection.pdfEmailRecipients = checked ? [...selection.pdfEmailRecipients, address]
        : selection.pdfEmailRecipients.filter((value) => value !== address);
      if (options.source === 'department_users') selection.pdfEmailRecipientUsers = selection.pdfEmailRecipients.map((email) => binding(options, email));
      update(); onChange();
    }
    function update() {
      const recipients = selection.pdfEmailRecipients;
      for (const { input } of choices) {
        input.checked = recipients.includes(input.value);
        input.disabled = !input.checked && recipients.length >= limit;
      }
      total.replaceChildren();
      element('span', 'Selected:', '', total);
      element('span', '', '', total).textContent = ' ' + recipients.length + ' / ' + limit;
      selectedSummary.replaceChildren();
      for (const [index, address] of recipients.slice(0, 3).entries()) {
        const row = element('li', '', '', selectedSummary);
        const detail = person(address, row); detail.id = id + '-selected-' + index;
        const remove = button('', 'secondary report-email-remove', row);
        const action = element('span', 'Remove', 'sr-only', remove); action.id = id + '-remove-' + index;
        element('span', '', '', remove).textContent = '×';
        remove.setAttribute('aria-labelledby', action.id + ' ' + detail.id);
        remove.addEventListener('click', () => {
          choose(address, false);
          (selectedSummary.children[Math.min(index, selectedSummary.children.length - 1)]?.querySelector('button') || toggle).focus();
        });
      }
      selectedSummary.hidden = !recipients.length;
      onlySelf.hidden = recipients.length > 0;
      more.hidden = recipients.length <= 3;
      clear.disabled = !recipients.length;
      limitNote.hidden = recipients.length < limit;
      toggle.hidden = !available.length;
      open(expanded && available.length > 0); filter();
    }
    for (const address of available) {
      const label = element('label', '', 'report-email-choice', list);
      const input = element('input', '', '', label);
      input.type = 'checkbox'; input.value = address;
      person(address, label);
      const name = options?.recipient_users?.find((user) => user.email === address)?.name || '';
      choices.push({ input, label, address, name });
      input.addEventListener('change', () => {
        const hadFocus = document.activeElement === input;
        choose(address, input.checked);
        // Filtering a deselected row must not strand keyboard focus on hidden UI.
        if (label.hidden && hadFocus) {
          const index = choices.findIndex((choice) => choice.input === input);
          const next = choices.slice(index + 1).find((choice) => !choice.label.hidden)
            || choices.slice(0, index).reverse().find((choice) => !choice.label.hidden);
          (next?.input || selected).focus();
        }
      });
    }
    search.addEventListener('input', () => { query = search.value; filter(); });
    // Enter in a search field must never submit the surrounding Report.
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
    all.addEventListener('click', () => { selectedOnly = false; filter(); });
    selected.addEventListener('click', () => { selectedOnly = true; filter(); });
    toggle.addEventListener('click', () => { open(!expanded); });
    more.addEventListener('click', () => { query = ''; search.value = ''; selectedOnly = true; filter(); open(true); selected.focus(); });
    clear.addEventListener('click', () => {
      selection = { pdfEmailRecipients: [], expectedPdfEmailVersion: options.version,
        ...(options.source === 'department_users' ? { pdfEmailRecipientUsers: [] } : {}) };
      update(); done.focus(); onChange();
    });
    done.addEventListener('click', () => { open(false); toggle.focus(); });
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open(false); toggle.focus(); }
    });
    update();
  }
  const capture = () => structuredClone({ ...selection, ...(optionsRequired && !Array.isArray(selection.pdfEmailRecipients) ? { pdfEmailOptionsUnavailable: true } : {}) });
  draw();
  return { capture,
    restore(saved) {
      optionsRequired ||= saved?.pdfEmailOptionsUnavailable === true;
      optionsUnavailable = optionsRequired && !options;
      selection = reportEmailSelection(options, saved); draw();
    },
    refresh(template) {
      const before = JSON.stringify(capture());
      options = reportEmailOptions(template);
      optionsRequired ||= template?.pdf_email_options != null;
      optionsUnavailable = optionsRequired && !options;
      if (options && !Array.isArray(selection.pdfEmailRecipients)) selection = reportEmailSelection(options);
      draw();
      if (JSON.stringify(capture()) !== before) onChange();
    },
    valid: () => !optionsUnavailable && !reportEmailSelectionStale(options, selection),
    remove: () => node.remove() };
}
