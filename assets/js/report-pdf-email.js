import * as api from './api-client.js';
import { setTranslatableText } from './i18n.js';
import { reportEmailOptions } from './report-email-recipients.js';

export function reportPdfEmailStatus(delivery) {
  if (!delivery) return '';
  if (Array.isArray(delivery.deliveries)) return delivery.deliveries.map((item) => `${item.recipient || 'Account email unavailable'} (${item.recipient_role || 'recipient'}): ${reportPdfEmailStatus({ ...item, deliveries: undefined })}`).join('\n');
  if (delivery.status === 'partial') return 'Some PDF copies were accepted; other copies failed. The Report is saved.';
  if (delivery.status === 'pending') return 'PDF email pending. The Report is submitted.';
  if (delivery.status === 'accepted') return 'PDF email accepted by the mail server; inbox delivery is unconfirmed.';
  if (delivery.status === 'uncertain') return 'PDF email acceptance is unconfirmed. Do not send again; check with the recipient first.';
  if (delivery.status === 'failed') {
    if (delivery.failure_code === 'invalid_recipient') return 'PDF email was not sent: the account email address is invalid. The Report is saved; contact your administrator.';
    if (delivery.failure_code === 'pdf_too_large') return 'PDF email was not sent: the PDF exceeds 10 MiB. The Report is saved; download its PDF.';
    if (delivery.failure_code === 'pdf_unavailable') return 'PDF email was not sent: the submitted PDF or its evidence is unavailable. The Report is saved.';
    return 'PDF email was not sent. The Report is saved; download its PDF or contact your administrator.';
  }
  return '';
}

export function mountTemplateEmailSettings(node, template, { isCurrent, canSave, onBusy, onSaved }) {
  // Old backends and retained Daywork never acquire email settings implicitly.
  if (template.template_purpose !== 'report' || !template.pdf_email) return;
  let saved = { ...template.pdf_email };
  let directory = reportEmailOptions(template);
  const departmentUsers = directory?.source === 'department_users';
  if (template.pdf_email_options != null && !directory) {
    const warning = document.createElement('p');
    warning.setAttribute('role', 'alert');
    setTranslatableText(warning, 'Recipient options are unavailable. Connect and refresh Templates before submitting this saved Report.');
    node.append(warning); return;
  }
  let busy = false;
  let requiresRefresh = false;
  const details = document.createElement('details');
  details.className = 'pdf-email-settings';
  details.innerHTML = `<summary>Email PDF after submission</summary>
    <form data-pdf-email-settings>
      <label class="checkbox-label"><input type="checkbox" data-pdf-email-enabled /><span data-pdf-email-enabled-label>Use a default additional recipient</span></label>
      <label><span>Recipient email</span> <small data-pdf-email-default-hint>(optional default)</small><input type="email" maxlength="254" autocomplete="off" data-pdf-email-recipient /></label>
      <p class="field-help" data-pdf-email-self-notice>The submitter receives their own copy automatically. All active users in this Template’s Department are available for additional copies, even without a default. Users may choose no additional copies.</p>
      <p class="field-help" data-pdf-email-eligibility>Only active accounts that have completed account setup are listed.</p>
      <p class="field-help">New submissions only. Queued PDFs keep their saved recipient. Includes photos and signatures; PDFs over 10 MiB are not sent.</p>
      <p class="field-help">These email settings save separately from the Template questions.</p>
      <button type="submit" class="secondary" data-template-mutation-action="email">Save email settings</button>
      <p role="status" aria-live="polite" data-pdf-email-feedback></p>
    </form>`;
  const form = details.querySelector('form');
  const enabled = form.querySelector('[data-pdf-email-enabled]');
  let recipient = form.querySelector('[data-pdf-email-recipient]');
  if (departmentUsers) {
    const select = document.createElement('select');
    select.dataset.pdfEmailRecipient = '';
    recipient.replaceWith(select); recipient = select;
  }
  form.querySelector('[data-pdf-email-default-hint]').hidden = !departmentUsers;
  form.querySelector('[data-pdf-email-eligibility]').hidden = !departmentUsers;
  form.querySelector('[data-pdf-email-self-notice]').hidden = !departmentUsers;
  if (!departmentUsers) setTranslatableText(form.querySelector('[data-pdf-email-enabled-label]'), 'Email PDF after submission');
  const unavailable = document.createElement('p');
  unavailable.className = 'field-help'; unavailable.setAttribute('role', 'alert');
  form.insertBefore(unavailable, form.querySelector('button'));
  function restoreSettings() {
    enabled.checked = saved.enabled;
    if (departmentUsers) {
      recipient.replaceChildren();
      const none = document.createElement('option'); none.value = '';
      setTranslatableText(none, 'No default recipient'); recipient.append(none);
      for (const address of directory.recipients) {
        const option = document.createElement('option'); option.value = address;
        option.textContent = address; option.dataset.noI18n = ''; recipient.append(option);
      }
      const current = directory.recipients.find((address) => address.toLowerCase() === saved.recipient?.trim().toLowerCase());
      const missing = saved.recipient && !current;
      unavailable.hidden = !missing;
      if (missing) {
        // Preserve the stored setting visibly, but never offer it as a choice.
        const old = document.createElement('option'); old.value = '__unavailable__'; old.disabled = true;
        setTranslatableText(old, 'Previous default is unavailable'); recipient.append(old);
        setTranslatableText(unavailable, 'The saved default is no longer an eligible Department user. Choose a current recipient or disable the default before saving.');
        recipient.value = '__unavailable__';
      } else recipient.value = current || '';
    } else { unavailable.hidden = true; recipient.value = saved.recipient || ''; }
    recipient.required = enabled.checked;
  }
  const feedback = form.querySelector('[data-pdf-email-feedback]');
  const controls = [...form.querySelectorAll('input, select, button')];
  restoreSettings();
  form.addEventListener('input', () => { form.dataset.refreshKeep = 'true'; });
  enabled.addEventListener('change', () => { recipient.required = enabled.checked; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || requiresRefresh || !isCurrent() || !canSave() || !form.reportValidity()) return;
    if (!navigator.onLine) {
      setTranslatableText(feedback, 'Connect before saving email settings.');
      return;
    }
    if (departmentUsers && enabled.checked && !directory.recipients.includes(recipient.value)) {
      setTranslatableText(feedback, 'Choose an active recipient in this Template’s Department or disable the default.');
      return;
    }
    const selected = recipient.value === '__unavailable__' ? null : recipient.value.trim() || null;
    const settings = { enabled: enabled.checked, recipient: selected, expected_version: saved.version };
    busy = true;
    onBusy(true);
    controls.forEach((control) => { control.disabled = true; });
    setTranslatableText(feedback, 'Saving email settings...');
    try {
      const updated = await api.updateWorkFormEmailSettings(template.id, settings);
      if (!isCurrent()) return;
      if (!updated?.pdf_email || updated.id !== template.id) throw new Error('Invalid settings response');
      saved = { ...updated.pdf_email };
      delete form.dataset.refreshKeep;
      if (departmentUsers) {
        const updatedDirectory = reportEmailOptions(updated);
        if (updatedDirectory?.source !== 'department_users') throw new Error('Missing Department recipient directory');
        directory = updatedDirectory;
      }
      restoreSettings();
      onSaved(updated);
      setTranslatableText(feedback, 'Email settings saved. Existing Reports will not be emailed.');
    } catch (error) {
      if (!isCurrent()) return;
      requiresRefresh = !error.status || error.status === 409 || error.status >= 500;
      setTranslatableText(feedback, requiresRefresh
        ? 'Email settings may have changed. Refresh the Template list before saving again.'
        : 'Could not save email settings. Check the recipient address and try again.');
    } finally {
      busy = false;
      onBusy(false);
      if (isCurrent()) {
        controls.forEach((control) => { control.disabled = requiresRefresh; });
      }
    }
  });
  node.append(details);
}
