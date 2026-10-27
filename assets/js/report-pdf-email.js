import * as api from './api-client.js';
import { setTranslatableText } from './i18n.js';

export function reportPdfEmailStatus(delivery) {
  if (!delivery) return '';
  if (delivery.status === 'pending') return 'PDF email pending. The Report is submitted.';
  if (delivery.status === 'accepted') return 'PDF email accepted by the mail server; inbox delivery is unconfirmed.';
  if (delivery.status === 'uncertain') return 'PDF email acceptance is unconfirmed. Do not send again; check with the recipient first.';
  if (delivery.status === 'failed') {
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
  let busy = false;
  let requiresRefresh = false;
  const details = document.createElement('details');
  details.className = 'pdf-email-settings';
  details.innerHTML = `<summary>Email PDF after submission</summary>
    <form data-pdf-email-settings>
      <label class="checkbox-label"><input type="checkbox" data-pdf-email-enabled /> Email PDF after submission</label>
      <label>Recipient email<input type="email" maxlength="254" autocomplete="off" data-pdf-email-recipient /></label>
      <p class="field-help">New submissions only. Queued PDFs keep their saved recipient. Includes photos and signatures; PDFs over 10 MiB are not sent.</p>
      <p class="field-help">These email settings save separately from the Template questions.</p>
      <button type="submit" class="secondary" data-template-mutation-action="email">Save email settings</button>
      <p role="status" aria-live="polite" data-pdf-email-feedback></p>
    </form>`;
  const form = details.querySelector('form');
  const enabled = form.querySelector('[data-pdf-email-enabled]');
  const recipient = form.querySelector('[data-pdf-email-recipient]');
  const feedback = form.querySelector('[data-pdf-email-feedback]');
  const controls = [...form.querySelectorAll('input, button')];
  enabled.checked = saved.enabled;
  recipient.value = saved.recipient || '';
  recipient.required = enabled.checked;
  form.addEventListener('input', () => { form.dataset.refreshKeep = 'true'; });
  enabled.addEventListener('change', () => { recipient.required = enabled.checked; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || requiresRefresh || !isCurrent() || !canSave() || !form.reportValidity()) return;
    if (!navigator.onLine) {
      setTranslatableText(feedback, 'Connect before saving email settings.');
      return;
    }
    const settings = { enabled: enabled.checked, recipient: recipient.value.trim() || null, expected_version: saved.version };
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
      enabled.checked = saved.enabled;
      recipient.value = saved.recipient || '';
      recipient.required = enabled.checked;
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
