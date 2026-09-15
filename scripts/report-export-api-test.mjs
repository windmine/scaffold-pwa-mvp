import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.window = { location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost' } };

const requests = [];
globalThis.fetch = async (url) => {
  requests.push(new URL(url, 'http://localhost'));
  return new Response('exported', { status: 200 });
};

const api = await import('../assets/js/api-client.js');
const { reportCollectionExportFilters } = await import('../assets/js/review-export-adapters.js');
const filters = reportCollectionExportFilters({
  purpose: 'report', kind: 'form', search: 'ladder & platform', workflowStatus: 'in_review',
  formId: '4', workerId: '7', departmentId: '2', recordDate: '2026-09-15', cursor: 'page-2', pageSize: 50
});
assert.deepEqual(filters, {
  purpose: 'report', search: 'ladder & platform', workflowStatus: 'in_review',
  formId: '4', workerId: '7', departmentId: '2', dateFrom: '2026-09-15', dateTo: '2026-09-15'
});
await api.exportSupervisorFormSubmissionsCsv(filters);
await api.exportSupervisorFormSubmissionsHtml(filters);
await api.exportSupervisorFormSubmissionsPdf('submitted-form', filters);
for (const request of requests) {
  if (request.searchParams.get('search') !== filters.search) {
    throw new Error(`Report collection download lost Find: ${request.pathname}`);
  }
  assert.deepEqual(Object.fromEntries(request.searchParams), {
    ...(request.pathname.endsWith('.pdf') ? { template: 'submitted-form' } : {}),
    workflow_status: 'in_review', date_from: '2026-09-15', date_to: '2026-09-15',
    form_id: '4', worker_id: '7', department_id: '2', purpose: 'report', search: 'ladder & platform'
  });
}
console.log('ok - CSV/HTML/PDF requests preserve Find and every Report filter, without a page limit');
