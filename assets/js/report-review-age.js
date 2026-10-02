// Backend timestamps without an explicit offset are UTC (including SQLite responses).
// Report Date is deliberately never involved in waiting age.
function submittedTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, offset] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  return Date.parse(offset ? value : `${value}Z`);
}

export function reportWaitingAgeLabel(record, now = Date.now()) {
  if (record?.type !== 'form' || record.submissionPurpose !== 'report'
    || record.workflowStatus !== 'submitted' || record.durability !== 'durable'
    || !record.backendRecordId || record.isDraftRecovery
    || ['queued', 'syncing'].includes(record.syncStatus)) return '';
  const submittedAt = submittedTime(record.createdAt);
  if (!Number.isFinite(submittedAt) || !Number.isFinite(now)) return '';
  const minutes = Math.floor(Math.max(0, now - submittedAt) / 60_000);
  if (minutes < 1) return 'Waiting less than 1 minute';
  if (minutes < 60) return `Waiting ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Waiting ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `Waiting ${days} day${days === 1 ? '' : 's'}`;
}
