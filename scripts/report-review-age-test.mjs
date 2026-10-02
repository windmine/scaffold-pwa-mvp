import assert from 'node:assert/strict';
import { reportWaitingAgeLabel } from '../assets/js/report-review-age.js';
import { translateText } from '../assets/js/i18n.js';

globalThis.localStorage = { getItem: () => null };
globalThis.window = { location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost' } };
const { mergeReviewRecords, mergeReviewRecordsInPageOrder } = await import('../assets/js/supervisor-review-utils.js');

const now = Date.parse('2026-10-02T00:00:00Z');
const record = { type: 'form', submissionPurpose: 'report', workflowStatus: 'submitted',
  durability: 'durable', backendRecordId: 19, syncStatus: 'synced', createdAt: '2026-10-01T00:00:00Z' };
let groups = 0;
function check(name, run) { run(); groups += 1; console.log(`PASS ${name}`); }

check('Waiting age has exact minute, hour and elapsed-day boundaries', () => {
  for (const [milliseconds, expected] of [
    [0, 'less than 1 minute'], [59_999, 'less than 1 minute'], [60_000, '1 minute'],
    [119_999, '1 minute'], [120_000, '2 minutes'], [3_599_999, '59 minutes'],
    [3_600_000, '1 hour'], [7_200_000, '2 hours'], [86_399_999, '23 hours'],
    [86_400_000, '1 day'], [172_800_000, '2 days']
  ]) assert.equal(reportWaitingAgeLabel({ ...record, createdAt: new Date(now - milliseconds).toISOString() }, now), `Waiting ${expected}`);
});
check('Report Date never affects submission age; future clock skew clamps to zero', () => {
  for (const workDate of ['1900-01-01', '2099-12-31', '', null]) {
    assert.equal(reportWaitingAgeLabel({ ...record, workDate }, now), 'Waiting 1 day');
  }
  assert.equal(reportWaitingAgeLabel({ ...record, createdAt: '2026-10-03T00:00:00Z' }, now), 'Waiting less than 1 minute');
});
check('UTC, offset, offsetless and microsecond backend timestamps agree', () => {
  for (const createdAt of ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00', '2026-10-01T00:00:00.000000',
    '2026-10-01T13:00:00+13:00', '2026-09-30T20:00:00-04:00']) {
    assert.equal(reportWaitingAgeLabel({ ...record, createdAt }, now), 'Waiting 1 day');
  }
  assert.equal(reportWaitingAgeLabel({ ...record, createdAt: '2026-10-01T00:00:00.999999Z' }, now), 'Waiting 23 hours');
});
check('Absent or malformed timestamps do not invent an age', () => {
  for (const createdAt of [null, undefined, '', 0, 'bad', '2026-10-01', '2026-02-30T00:00:00Z',
    '2026-10-01T24:00:00Z', '2026-10-01T00:60:00Z', '2026-10-01T00:00:60Z', '2026-10-01T00:00:00+99:00']) {
    assert.equal(reportWaitingAgeLabel({ ...record, createdAt }, now), '');
  }
  assert.equal(reportWaitingAgeLabel(record, NaN), '');
});
check('Only durable Submitted Reports receive waiting labels', () => {
  for (const changed of [{ type: 'task' }, { submissionPurpose: 'daywork' }, { submissionPurpose: '' },
    { workflowStatus: 'in_review' }, { workflowStatus: 'resolved' }, { workflowStatus: undefined },
    { durability: 'local_only' }, { backendRecordId: null }, { isDraftRecovery: true },
    { syncStatus: 'queued' }, { syncStatus: 'syncing' }]) assert.equal(reportWaitingAgeLabel({ ...record, ...changed }, now), '');
  assert.equal(reportWaitingAgeLabel({ ...record, readOnly: true }, now), 'Waiting 1 day');
});
check('English and Chinese age labels round-trip without translating Report content', () => {
  assert.equal(translateText('Submitted: Unavailable', 'zh'), '提交时间：不可用');
  for (const [text, expected] of [['Waiting less than 1 minute', '已等待不足 1 分钟'],
    ['Waiting 1 minute', '已等待 1 分钟'], ['Waiting 2 minutes', '已等待 2 分钟'],
    ['Waiting 1 hour', '已等待 1 小时'], ['Waiting 23 hours', '已等待 23 小时'],
    ['Waiting 1 day', '已等待 1 天'], ['Waiting 99 days', '已等待 99 天']]) {
    assert.equal(translateText(text, 'zh'), expected);
    assert.equal(translateText(text, 'en'), text);
  }
});
check('Paginated Reports keep server order and deduplicate; retained merge still sorts newest', () => {
  const oldest = { ...record, backendRecordId: 1, createdAt: '2026-09-01T00:00:00Z' };
  const newest = { ...record, backendRecordId: 2, createdAt: '2026-10-01T00:00:00Z' };
  const updated = { ...oldest, workflowStatus: 'in_review' };
  assert.deepEqual(mergeReviewRecordsInPageOrder([oldest, newest], [updated]).map((item) => item.backendRecordId), [1, 2]);
  assert.equal(mergeReviewRecordsInPageOrder([oldest], [updated])[0], updated);
  assert.deepEqual(mergeReviewRecords([oldest, newest]).map((item) => item.backendRecordId), [2, 1]);
});
console.log(`Report review age: ${groups} groups passed.`);
