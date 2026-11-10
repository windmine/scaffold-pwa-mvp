import { setTranslatableText } from './i18n.js';

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

export function mountReportEmailRecipients(container, template, email, saved, onChange = () => {}) {
  let options = reportEmailOptions(template);
  let optionsRequired = template?.pdf_email_options != null || saved?.pdfEmailOptionsUnavailable === true;
  let optionsUnavailable = optionsRequired && !options;
  let selection = reportEmailSelection(options, saved);
  const document = container.ownerDocument;
  const node = document.createElement('fieldset');
  node.className = 'report-email-recipients';
  node.dataset.reportEmailRecipients = '';
  const submit = container.querySelector('#submitWorkFormButton');
  const before = submit?.closest('.work-form-submit-row') || submit;
  container.insertBefore(node, before?.parentElement === container ? before : null);
  function message(text, className = '') {
    const p = document.createElement('p');
    p.className = className; setTranslatableText(p, text); node.append(p); return p;
  }
  function draw() {
    node.replaceChildren();
    node.hidden = !optionsUnavailable && !options && !Array.isArray(selection.pdfEmailRecipients);
    if (node.hidden) return;
    const legend = document.createElement('legend');
    setTranslatableText(legend, 'PDF email copies'); node.append(legend);
    const self = document.createElement('p');
    const selfLabel = document.createElement('span');
    setTranslatableText(selfLabel, 'Your PDF copy');
    const address = document.createElement('span');
    address.textContent = `: ${email || 'your account email'}. `; address.dataset.noI18n = '';
    const notice = document.createElement('span');
    setTranslatableText(notice, 'Email is queued after this Report syncs. Inbox delivery is not guaranteed.');
    self.append(selfLabel, address, notice); node.append(self);
    if (optionsUnavailable || reportEmailSelectionStale(options, selection)) {
      const warning = message(options
        ? 'Department recipients changed. Your previous selection is kept below. Review the current list before submitting.'
        : 'Recipient options are unavailable. Connect and refresh Templates before submitting this saved Report.');
      warning.setAttribute('role', 'alert');
      const previous = document.createElement('p');
      const label = document.createElement('span'); setTranslatableText(label, 'Previous additional copies');
      const addresses = document.createElement('span'); addresses.dataset.noI18n = '';
      addresses.textContent = `: ${selection.pdfEmailRecipients?.join(', ') || 'None'}`;
      previous.append(label, addresses); node.append(previous);
      if (!options) return;
      message('Reviewing keeps only the same eligible accounts and email addresses. Unavailable selections are removed; no replacement recipients are selected.', 'field-help');
      const review = document.createElement('button'); review.type = 'button';
      setTranslatableText(review, 'Review updated recipients');
      review.addEventListener('click', () => {
        const recipients = selection.pdfEmailRecipients.filter((email) => selectedAccountAvailable(options, selection, email));
        selection = { pdfEmailRecipients: recipients, expectedPdfEmailVersion: options.version,
          ...(options.source === 'department_users' ? { pdfEmailRecipientUsers: recipients.map((email) => binding(options, email)) } : {}) };
        draw(); onChange();
      });
      node.append(review); return;
    }
    message('Choose additional recipients from active users in this Template’s Department. Leave all unchecked for your copy only.', 'field-help');
    message('Only active accounts that have completed account setup are listed.', 'field-help');
    const limit = options?.max_selected_recipients || 20;
    const cap = message('Select up to 20 additional recipients per Report. The full Department list is shown.', 'field-help');
    if (limit !== 20) cap.textContent = `Select up to ${limit} additional recipients per Report.`;
    if (options?.default_recipient_unavailable) message('The previous default recipient is unavailable. No replacement was selected. Review your choices before submitting.', 'field-help');
    const available = options?.source === 'department_users' || options?.enabled ? options.recipients : [];
    if (!available.length) message('No eligible additional recipients are available in this Department.', 'field-help');
    const choices = [];
    const updateLimit = () => {
      for (const input of choices) input.disabled = !input.checked && selection.pdfEmailRecipients.length >= limit;
    };
    for (const address of available) {
      const label = document.createElement('label'); label.className = 'checkbox-label';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = selection.pdfEmailRecipients.includes(address);
      input.addEventListener('change', () => {
        if (input.checked && selection.pdfEmailRecipients.length >= limit) { input.checked = false; return; }
        selection.expectedPdfEmailVersion = options.version;
        selection.pdfEmailRecipients = input.checked ? [...selection.pdfEmailRecipients, address]
          : selection.pdfEmailRecipients.filter((value) => value !== address);
        if (options.source === 'department_users') selection.pdfEmailRecipientUsers = selection.pdfEmailRecipients.map((email) => binding(options, email));
        updateLimit(); onChange();
      });
      const text = document.createElement('span'); text.textContent = address; text.dataset.noI18n = '';
      label.append(input, text); node.append(label); choices.push(input);
    }
    updateLimit();
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
