// A typed label belongs to this Report only; it never creates or resolves a Site.
export const MANUAL_SITE = '__manual__';

export function syncReportSiteInput(select, input) {
  if (!input) return;
  const manual = select.value === MANUAL_SITE;
  input.closest('label').hidden = !manual;
  input.required = manual;
}

export function readReportSite(select, input) {
  const manual = select.value === MANUAL_SITE;
  return {
    siteId: manual ? '' : select.value,
    siteMode: manual ? 'manual' : 'existing',
    manualSiteName: manual ? (input?.value || '') : ''
  };
}

export function restoreReportSite(select, input, value = {}) {
  const manual = value.siteMode === 'manual' || Boolean(value.manualSiteName);
  select.value = manual ? MANUAL_SITE : String(value.siteId || '');
  if (input) input.value = value.manualSiteName || '';
  syncReportSiteInput(select, input);
}

export function validateReportSite(value) {
  if (value.siteMode !== 'manual') return '';
  if (!value.manualSiteName.trim()) return 'Enter a site name or choose No site.';
  if (value.manualSiteName.length > 200 || [...value.manualSiteName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return 'Site name must be a single line of up to 200 characters.';
  }
  return '';
}
