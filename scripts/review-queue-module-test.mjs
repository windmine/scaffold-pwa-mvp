const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.window = {
  location: {
    protocol: 'http:',
    hostname: 'localhost',
    origin: 'http://localhost'
  }
};

const { createReviewExportAdapters } = await import('../assets/js/review-export-adapters.js');
const {
  loadReviewOverview,
  reviewOverviewCounts
} = await import('../assets/js/supervisor-review-utils.js');
const {
  managementAnalyticsRecords,
  managementCsv
} = await import('../assets/js/supervisor-analytics.js');


function assert(condition, message) {
  if (!condition) throw new Error(message);
}


async function expectRejected(label, operation) {
  try {
    await operation();
  } catch {
    console.log(`ok - ${label}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}


const calls = [];
const downloads = [];
const blob = new Blob(['review'], { type: 'text/plain' });
const operationNames = [
  'attendanceCsv',
  'taskLogsCsv',
  'taskLogsHtml',
  'formSubmissionsCsv',
  'formSubmissionsHtml',
  'formSubmissionsPdf',
  'taskLogCsv',
  'taskLogHtml',
  'formSubmissionCsv',
  'formSubmissionHtml',
  'formSubmissionPdf'
];
const operations = Object.fromEntries(operationNames.map((operation) => [
  operation,
  async (...args) => {
    calls.push({ operation, args });
    return blob;
  }
]));
const adapters = createReviewExportAdapters({
  operations,
  currentDate: () => '2026-07-14',
  download: (value, filename) => downloads.push({ value, filename })
});

const collectionMessage = await adapters.exportCollection('attendance-csv', { dateFrom: '2026-07-01' });
assert(collectionMessage === 'Attendance CSV exported.', 'collection Adapter returned wrong message');
assert(calls[0]?.operation === 'attendanceCsv', 'collection Adapter dispatched wrong operation');
assert(downloads[0]?.filename === 'leader-attendance-2026-07-14.csv', 'collection Adapter used wrong filename');
console.log('ok - Review Queue collection export Adapter');

const durableRecord = {
  backendRecordId: 42,
  type: 'task',
  durability: 'durable',
  readOnly: false
};
const recordMessage = await adapters.exportRecord(durableRecord, 'task-csv');
assert(recordMessage === 'Task log CSV row exported.', 'record Adapter returned wrong message');
assert(calls[1]?.operation === 'taskLogCsv', 'record Adapter dispatched wrong operation');
console.log('ok - durable Review Record export Adapter');

await expectRejected(
  'local-only Review Record export is rejected',
  () => adapters.exportRecord({ ...durableRecord, durability: 'local_only' }, 'task-csv')
);
await expectRejected(
  'unclassified Review Record export is rejected',
  () => adapters.exportRecord({ ...durableRecord, durability: undefined }, 'task-csv')
);
await expectRejected(
  'read-only Review Record export is rejected',
  () => adapters.exportRecord({ ...durableRecord, readOnly: true }, 'task-csv')
);
await expectRejected(
  'unknown Review Queue export Adapter is rejected',
  () => adapters.exportCollection('unknown-export')
);

const summaryCounts = {
  total: 2,
  pending: 1,
  reviewed: 1,
  attendance: 2,
  task: 0,
  teamLog: 0,
  form: 0
};
const selectedCounts = reviewOverviewCounts({
  queueCounts: { ...summaryCounts, total: 1, reviewed: 0 },
  queueSummaryCounts: summaryCounts
});
assert(selectedCounts.reviewed === 1, 'dashboard must use filter-independent summary counts');
console.log('ok - Review Queue dashboard uses summary counts');

const safeManagementCsv = managementCsv({
  metrics: {
    records: 0,
    workers: 0,
    sites: 1,
    approvalRate: 0,
    pending: 0,
    outsideSite: 0,
    missingCheckOut: 0,
    loggedHours: 0
  },
  sites: [{
    siteName: '=HYPERLINK("https://example.invalid")',
    workers: 0,
    records: [],
    attendance: 0,
    loggedHours: 0,
    forms: 0,
    approvalRate: 0,
    exceptionCount: 0
  }],
  trend: [],
  formCharts: [],
  exceptions: []
}, 'Last 7 days');
assert(
  safeManagementCsv.includes('"\'=HYPERLINK(""https://example.invalid"")"'),
  'management CSV must neutralize spreadsheet formulas in user-controlled values'
);
console.log('ok - Management CSV neutralizes spreadsheet formulas');

const pageRequests = [];
const overview = await loadReviewOverview({
  departmentId: 7,
  loadPage: async (request) => {
    pageRequests.push(request);
    if (!request.cursor) {
      return {
        items: [{ id: 1, kind: 'attendance' }],
        counts: { total: 1 },
        summary_counts: summaryCounts,
        has_more: true,
        next_cursor: 'second-page',
        snapshot_at: '2026-07-14T00:00:00Z'
      };
    }
    return {
      items: [{ id: 2, kind: 'form' }],
      counts: { total: 2 },
      summary_counts: summaryCounts,
      has_more: false,
      next_cursor: null,
      snapshot_at: '2026-07-14T00:00:00Z'
    };
  },
  mapRecord: (record) => ({ backendRecordId: record.id, type: record.kind })
});
assert(overview.records.length === 2, 'Analytics overview must traverse every cursor page');
assert(overview.counts.reviewed === 1, 'Analytics overview must retain summary counts');
assert(pageRequests.length === 2, 'Analytics overview must request the continuation page');
assert(
  pageRequests.every((request) => (
    request.departmentId === 7
    && request.status == null
    && request.kind == null
    && request.search == null
    && request.recordDate == null
  )),
  'Analytics overview query must not inherit Review Queue filters'
);
console.log('ok - Management Analytics loads an unfiltered cursor snapshot');

const pendingRecord = { id: 1, status: 'pending' };
const approvedRecord = { id: 2, status: 'approved' };
const analyticsRecords = managementAnalyticsRecords({
  reviewRecords: [pendingRecord],
  analyticsRecords: [pendingRecord, approvedRecord]
});
assert(analyticsRecords.length === 2, 'Management Analytics must not use the filtered Review Queue page');
console.log('ok - Management Analytics uses its complete dataset');

console.log('review queue module test passed');
