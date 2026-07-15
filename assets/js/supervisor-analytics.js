import { dateInputValue, escapeHtml, formatDateTime, todayDateInput } from './utils.js';

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MISSING_CHECK_OUT_GRACE_MS = 12 * 60 * 60 * 1000;

function recordDate(record) {
  return record.workDate || dateInputValue(record.createdAt);
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function csvCell(value) {
  const source = String(value ?? '');
  const firstVisible = source.replace(/^[ \t\r\n]+/, '');
  const text = typeof value === 'string'
    && (/^[\t\r\n]/.test(source) || /^[=+\-@]/.test(firstVisible))
    ? `'${source}`
    : source;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function periodStart(periodDays, now) {
  if (!Number.isFinite(periodDays)) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - periodDays + 1);
  return start;
}

function filterByPeriod(records, periodDays, now) {
  const start = periodStart(periodDays, now);
  if (!start) return [...records];
  return records.filter((record) => {
    const value = new Date(`${recordDate(record)}T00:00:00`);
    return !Number.isNaN(value.getTime()) && value >= start;
  });
}

function approvalRate(records) {
  if (!records.length) return 0;
  return Math.round((records.filter((record) => record.status === 'approved').length / records.length) * 100);
}

function buildTrend(records, exceptions, periodDays, now) {
  const buckets = [];
  const finitePeriod = Number.isFinite(periodDays);

  if (finitePeriod && periodDays <= 30) {
    const start = periodStart(periodDays, now);
    for (let offset = 0; offset < periodDays; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      const key = dateInputValue(date);
      buckets.push({ key, label: `${date.getDate()}/${date.getMonth() + 1}`, total: 0, exceptions: 0 });
    }
  } else if (finitePeriod) {
    const start = periodStart(periodDays, now);
    const weekCount = Math.ceil(periodDays / 7);
    for (let offset = 0; offset < weekCount; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset * 7);
      buckets.push({
        key: String(offset),
        label: `${date.getDate()}/${date.getMonth() + 1}`,
        total: 0,
        exceptions: 0
      });
    }
  } else {
    const months = new Map();
    records.forEach((record) => {
      const key = recordDate(record).slice(0, 7);
      if (key) months.set(key, { key, label: key, total: 0, exceptions: 0 });
    });
    buckets.push(...Array.from(months.values()).sort((a, b) => a.key.localeCompare(b.key)));
  }

  const bucketByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const start = periodStart(periodDays, now);
  function bucketKey(value) {
    let key = value;
    if (Number.isFinite(periodDays) && periodDays > 30) {
      const date = new Date(`${key}T00:00:00`);
      key = String(Math.max(0, Math.floor((date - start) / (7 * 24 * 60 * 60 * 1000))));
    } else if (!Number.isFinite(periodDays)) {
      key = key.slice(0, 7);
    }
    return key;
  }

  records.forEach((record) => {
    const key = bucketKey(recordDate(record));
    const bucket = bucketByKey.get(key);
    if (!bucket) return;
    bucket.total += 1;
  });
  exceptions.forEach((exception) => {
    const bucket = bucketByKey.get(bucketKey(exception.date));
    if (bucket) bucket.exceptions += 1;
  });
  return buckets;
}

function addException(exceptions, category, record, detail, severity = 'attention') {
  exceptions.push({
    category,
    severity,
    recordId: record.backendRecordId || record.id,
    userName: record.userName || 'Worker',
    siteName: record.siteName || 'Unassigned site',
    date: recordDate(record),
    createdAt: record.createdAt,
    detail
  });
}

function detectExceptions(records, now) {
  const exceptions = [];
  records.forEach((record) => {
    if (record.status === 'pending') {
      addException(exceptions, 'Pending review', record, `${record.type} record still needs a decision.`);
    }
    if (record.status === 'rejected') {
      addException(exceptions, 'Rejected record', record, `${record.type} record was rejected.`, 'danger');
    }
    if (record.type === 'attendance' && record.withinSiteRadius === false) {
      addException(
        exceptions,
        'Outside site',
        record,
        `${record.distanceFromSiteM ?? 'Unknown'}m from the selected site.`,
        'danger'
      );
    }
    if (record.type === 'attendance' && numericValue(record.location?.accuracy) > 100) {
      addException(
        exceptions,
        'Low GPS accuracy',
        record,
        `${Math.round(Number(record.location.accuracy))}m reported accuracy.`
      );
    }
  });

  const attendance = records
    .filter((record) => record.type === 'attendance')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const lastByAction = new Map();
  attendance.forEach((record) => {
    const key = `${record.userId}|${record.siteId}|${record.action}`;
    const previous = lastByAction.get(key);
    if (previous && new Date(record.createdAt) - new Date(previous.createdAt) <= DUPLICATE_WINDOW_MS) {
      addException(exceptions, 'Possible duplicate', record, `Same ${record.action.replace('_', ' ')} within 10 minutes.`);
    }
    lastByAction.set(key, record);
  });

  const attendanceGroups = new Map();
  attendance.forEach((record) => {
    const key = `${record.userId}|${record.siteId}`;
    const group = attendanceGroups.get(key) || [];
    group.push(record);
    attendanceGroups.set(key, group);
  });
  attendanceGroups.forEach((group) => {
    const unmatchedCheckIns = [];
    group.forEach((record) => {
      if (record.action === 'check_in') {
        unmatchedCheckIns.push(record);
      } else if (unmatchedCheckIns.length) {
        unmatchedCheckIns.pop();
      } else {
        addException(exceptions, 'Check-out without check-in', record, 'No earlier open check-in was found for this worker and site.');
      }
    });
    unmatchedCheckIns.forEach((record) => {
      const checkInTime = new Date(record.createdAt);
      if (
        !Number.isNaN(checkInTime.getTime())
        && now - checkInTime >= MISSING_CHECK_OUT_GRACE_MS
      ) {
        addException(
          exceptions,
          'Missing check-out',
          record,
          'No check-out has been recorded and this check-in is at least 12 hours old.',
          'danger'
        );
      }
    });
  });

  return exceptions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function buildSiteSummaries(records, exceptions) {
  const sites = new Map();
  records.forEach((record) => {
    const key = String(record.siteId ?? record.siteName ?? 'unassigned');
    if (!sites.has(key)) {
      sites.set(key, {
        siteId: record.siteId,
        siteName: record.siteName || 'Unassigned site',
        records: [],
        workers: new Set(),
        attendance: 0,
        forms: 0,
        taskLogs: 0,
        loggedHours: 0
      });
    }
    const site = sites.get(key);
    site.records.push(record);
    if (record.userId != null) site.workers.add(record.userId);
    if (record.type === 'attendance') site.attendance += 1;
    if (record.type === 'form') site.forms += 1;
    if (record.type === 'task') {
      site.taskLogs += 1;
      site.loggedHours += numericValue(record.hoursWorked) || 0;
    }
  });

  return Array.from(sites.values())
    .map((site) => ({
      ...site,
      workers: site.workers.size,
      loggedHours: Math.round(site.loggedHours * 100) / 100,
      approvalRate: approvalRate(site.records),
      exceptionCount: exceptions.filter((exception) => exception.siteName === site.siteName).length
    }))
    .sort((a, b) => b.records.length - a.records.length);
}

function buildFormCharts(records) {
  const groups = new Map();
  records.filter((record) => record.type === 'form').forEach((record) => {
    (record.fields || []).forEach((field) => {
      if (field.repeat || ['section', 'signature', 'textarea', 'text', 'date', 'time_range', 'formula', 'repeat'].includes(field.type)) {
        return;
      }
      const value = record.answers?.[field.id];
      if (value == null || value === '') return;
      const key = `${record.formId}|${field.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          formName: record.formName,
          fieldLabel: field.label || field.id,
          type: field.type,
          values: []
        });
      }
      groups.get(key).values.push(value);
    });
  });

  return Array.from(groups.values()).map((group) => {
    if (group.type === 'number') {
      const values = group.values.map(numericValue).filter((value) => value != null);
      return {
        ...group,
        kind: 'number',
        count: values.length,
        average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
        minimum: values.length ? Math.min(...values) : 0,
        maximum: values.length ? Math.max(...values) : 0
      };
    }

    const counts = new Map();
    group.values.forEach((value) => {
      const label = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    return {
      ...group,
      kind: 'category',
      count: group.values.length,
      options: Array.from(counts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
    };
  }).sort((a, b) => b.count - a.count);
}

export function buildManagementAnalytics(records, periodDays, now = new Date()) {
  const filteredRecords = filterByPeriod(records, periodDays, now);
  const exceptions = detectExceptions(filteredRecords, now);
  return {
    records: filteredRecords,
    trend: buildTrend(filteredRecords, exceptions, periodDays, now),
    exceptions,
    sites: buildSiteSummaries(filteredRecords, exceptions),
    formCharts: buildFormCharts(filteredRecords),
    metrics: {
      records: filteredRecords.length,
      workers: new Set(filteredRecords.map((record) => record.userId).filter((value) => value != null)).size,
      sites: new Set(filteredRecords.map((record) => record.siteId ?? record.siteName).filter(Boolean)).size,
      approvalRate: approvalRate(filteredRecords),
      pending: filteredRecords.filter((record) => record.status === 'pending').length,
      outsideSite: filteredRecords.filter((record) => record.type === 'attendance' && record.withinSiteRadius === false).length,
      missingCheckOut: exceptions.filter((exception) => exception.category === 'Missing check-out').length,
      loggedHours: Math.round(
        filteredRecords
          .filter((record) => record.type === 'task')
          .reduce((sum, record) => sum + (numericValue(record.hoursWorked) || 0), 0) * 100
      ) / 100
    }
  };
}

export function managementAnalyticsRecords(supervisorRecords = {}) {
  return Array.isArray(supervisorRecords.analyticsRecords)
    ? supervisorRecords.analyticsRecords
    : [];
}

function periodLabel(periodDays) {
  return Number.isFinite(periodDays) ? `Last ${periodDays} days` : 'All available records';
}

function renderTrend(container, trend) {
  const maximum = Math.max(1, ...trend.map((bucket) => bucket.total));
  container.innerHTML = trend.length
    ? trend.map((bucket) => `
        <div class="analytics-trend-column" title="${escapeHtml(`${bucket.label}: ${bucket.total} records, ${bucket.exceptions} exceptions`)}">
          <div class="analytics-trend-bars">
            <i class="analytics-trend-bar exceptions" style="height: ${(bucket.exceptions / maximum) * 100}%"></i>
            <i class="analytics-trend-bar total" style="height: ${(bucket.total / maximum) * 100}%"></i>
          </div>
          <small>${escapeHtml(bucket.label)}</small>
        </div>
      `).join('')
    : '<div class="empty-state">No trend data is available for this period.</div>';
}

function renderExceptionList(container, exceptions) {
  container.innerHTML = exceptions.length
    ? exceptions.slice(0, 40).map((exception) => `
        <article class="analytics-exception ${escapeHtml(exception.severity)}">
          <div>
            <strong>${escapeHtml(exception.category)}</strong>
            <p>${escapeHtml(exception.userName)} | ${escapeHtml(exception.siteName)} | ${escapeHtml(exception.date)}</p>
          </div>
          <span>${escapeHtml(exception.detail)}</span>
        </article>
      `).join('')
    : '<div class="empty-state">No exceptions were detected for this period.</div>';
}

function renderExceptionSummary(container, exceptions) {
  const counts = new Map();
  exceptions.forEach((exception) => {
    counts.set(exception.category, (counts.get(exception.category) || 0) + 1);
  });
  container.innerHTML = counts.size
    ? Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `<span><strong>${count}</strong>${escapeHtml(category)}</span>`)
      .join('')
    : '<span><strong>0</strong>No exceptions</span>';
}

function renderSites(container, sites) {
  container.innerHTML = sites.length
    ? `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr><th>Site</th><th>Workers</th><th>Records</th><th>Attendance</th><th>Task hours</th><th>Forms</th><th>Approved</th><th>Exceptions</th></tr>
          </thead>
          <tbody>
            ${sites.map((site) => `
              <tr>
                <th>${escapeHtml(site.siteName)}</th>
                <td>${site.workers}</td>
                <td>${site.records.length}</td>
                <td>${site.attendance}</td>
                <td>${site.loggedHours}</td>
                <td>${site.forms}</td>
                <td>${site.approvalRate}%</td>
                <td>${site.exceptionCount}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
    : '<div class="empty-state">No site activity is available for this period.</div>';
}

function renderFormCharts(container, charts) {
  container.innerHTML = charts.length
    ? charts.slice(0, 12).map((chart) => {
        if (chart.kind === 'number') {
          return `
            <article class="analytics-response-chart">
              <h3>${escapeHtml(chart.formName)}: ${escapeHtml(chart.fieldLabel)}</h3>
              <p>${chart.count} responses</p>
              <div class="analytics-number-summary">
                <span><small>Average</small><strong>${Math.round(chart.average * 100) / 100}</strong></span>
                <span><small>Minimum</small><strong>${chart.minimum}</strong></span>
                <span><small>Maximum</small><strong>${chart.maximum}</strong></span>
              </div>
            </article>
          `;
        }
        const maximum = Math.max(1, ...chart.options.map((option) => option.count));
        return `
          <article class="analytics-response-chart">
            <h3>${escapeHtml(chart.formName)}: ${escapeHtml(chart.fieldLabel)}</h3>
            <p>${chart.count} responses</p>
            <div class="analytics-horizontal-chart">
              ${chart.options.slice(0, 8).map((option) => `
                <div>
                  <span>${escapeHtml(option.label)}</span>
                  <i><b style="width: ${(option.count / maximum) * 100}%"></b></i>
                  <strong>${option.count}</strong>
                </div>
              `).join('')}
            </div>
          </article>
        `;
      }).join('')
    : '<div class="empty-state">Select, checkbox, and numeric form responses will appear here.</div>';
}

export function managementCsv(analytics, label) {
  const rows = [
    ['section', 'name', 'value', 'site', 'workers', 'records', 'attendance', 'task_hours', 'forms', 'approval_rate', 'exceptions', 'date', 'detail'],
    ['report', 'period', label],
    ['metric', 'records', analytics.metrics.records],
    ['metric', 'workers', analytics.metrics.workers],
    ['metric', 'sites', analytics.metrics.sites],
    ['metric', 'approval_rate_percent', analytics.metrics.approvalRate],
    ['metric', 'pending', analytics.metrics.pending],
    ['metric', 'outside_site', analytics.metrics.outsideSite],
    ['metric', 'missing_check_out', analytics.metrics.missingCheckOut],
    ['metric', 'logged_task_hours', analytics.metrics.loggedHours],
    ...analytics.sites.map((site) => [
      'site_summary', site.siteName, '', site.siteName, site.workers, site.records.length,
      site.attendance, site.loggedHours, site.forms, site.approvalRate, site.exceptionCount
    ]),
    ...analytics.trend.map((bucket) => [
      'trend', bucket.label, bucket.total, '', '', '', '', '', '', '', bucket.exceptions
    ]),
    ...analytics.formCharts.flatMap((chart) => (
      chart.kind === 'number'
        ? [
          ['form_response', `${chart.formName}: ${chart.fieldLabel} average`, chart.average],
          ['form_response', `${chart.formName}: ${chart.fieldLabel} minimum`, chart.minimum],
          ['form_response', `${chart.formName}: ${chart.fieldLabel} maximum`, chart.maximum]
        ]
        : chart.options.map((option) => [
          'form_response', `${chart.formName}: ${chart.fieldLabel} = ${option.label}`, option.count
        ])
    )),
    ...analytics.exceptions.map((exception) => [
      'exception', exception.category, '', exception.siteName, exception.userName, '', '', '', '', '', '',
      exception.date, exception.detail
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function managementHtml(analytics, label) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Management report</title>
<style>
body{font-family:Arial,sans-serif;margin:32px;color:#172033}h1,h2{color:#071425}small{color:#596579}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric{border:1px solid #ccd6e3;padding:12px}
.metric strong{display:block;font-size:24px;margin-top:4px}table{width:100%;border-collapse:collapse;margin:12px 0 24px}
th,td{border:1px solid #ccd6e3;padding:8px;text-align:left}th{background:#edf4ff}
.exception{border-left:4px solid #e9b85d;padding:8px 12px;margin:8px 0;background:#fffaf0}
@media print{body{margin:12mm}.metrics{grid-template-columns:repeat(4,1fr)}}
</style></head><body>
<h1>Leader Field Operations Management Report</h1>
<p>${escapeHtml(label)} | Generated ${escapeHtml(formatDateTime(new Date()))}</p>
<div class="metrics">
${[
    ['Records', analytics.metrics.records],
    ['Workers', analytics.metrics.workers],
    ['Sites', analytics.metrics.sites],
    ['Approved', `${analytics.metrics.approvalRate}%`],
    ['Pending', analytics.metrics.pending],
    ['Outside site', analytics.metrics.outsideSite],
    ['Missing check-outs (12h+)', analytics.metrics.missingCheckOut],
    ['Logged task hours', analytics.metrics.loggedHours]
  ].map(([name, value]) => `<div class="metric"><small>${escapeHtml(name)}</small><strong>${escapeHtml(value)}</strong></div>`).join('')}
</div>
<h2>Site productivity summary</h2>
<table><thead><tr><th>Site</th><th>Workers</th><th>Records</th><th>Attendance</th><th>Task hours</th><th>Forms</th><th>Approved</th><th>Exceptions</th></tr></thead>
<tbody>${analytics.sites.map((site) => `<tr><td>${escapeHtml(site.siteName)}</td><td>${site.workers}</td><td>${site.records.length}</td><td>${site.attendance}</td><td>${site.loggedHours}</td><td>${site.forms}</td><td>${site.approvalRate}%</td><td>${site.exceptionCount}</td></tr>`).join('')}</tbody></table>
<h2>Exceptions</h2>
${analytics.exceptions.length ? analytics.exceptions.map((exception) => `<div class="exception"><strong>${escapeHtml(exception.category)}</strong><br>${escapeHtml(exception.userName)} | ${escapeHtml(exception.siteName)} | ${escapeHtml(exception.date)}<br><small>${escapeHtml(exception.detail)}</small></div>`).join('') : '<p>No exceptions detected.</p>'}
<h2>Form response summary</h2>
${analytics.formCharts.length ? analytics.formCharts.map((chart) => chart.kind === 'number'
    ? `<p><strong>${escapeHtml(chart.formName)}: ${escapeHtml(chart.fieldLabel)}</strong><br>Average ${Math.round(chart.average * 100) / 100}; minimum ${chart.minimum}; maximum ${chart.maximum}; ${chart.count} responses.</p>`
    : `<p><strong>${escapeHtml(chart.formName)}: ${escapeHtml(chart.fieldLabel)}</strong><br>${chart.options.map((option) => `${escapeHtml(option.label)}: ${option.count}`).join('; ')}</p>`
  ).join('') : '<p>No structured form responses available.</p>'}
</body></html>`;
}

export function createSupervisorAnalyticsModule({ els, state, renderStatusBanner }) {
  function selectedPeriod() {
    return els.analyticsPeriodSelect.value === 'all'
      ? Number.POSITIVE_INFINITY
      : Number(els.analyticsPeriodSelect.value);
  }

  function analytics() {
    const focusedRecords = managementAnalyticsRecords(state.supervisorRecords).filter((record) => (
      !state.departmentFocusId
      || String(record.departmentId ?? state.user?.departmentId) === String(state.departmentFocusId)
    ));
    return buildManagementAnalytics(
      focusedRecords,
      selectedPeriod()
    );
  }

  function renderPanel() {
    const report = analytics();
    const label = periodLabel(selectedPeriod());
    const analyticsReady = Boolean(state.supervisorRecords.analyticsReady);
    els.analyticsPeriodLabel.textContent = analyticsReady
      ? label
      : 'Complete Analytics data unavailable';
    els.analyticsExceptionCount.textContent = `${report.exceptions.length} exceptions`;
    els.analyticsMetrics.innerHTML = [
      ['Records', report.metrics.records],
      ['Workers', report.metrics.workers],
      ['Sites', report.metrics.sites],
      ['Approved', `${report.metrics.approvalRate}%`],
      ['Pending', report.metrics.pending],
      ['Outside site', report.metrics.outsideSite],
      ['Missing check-outs (12h+)', report.metrics.missingCheckOut],
      ['Logged task hours', report.metrics.loggedHours]
    ].map(([name, value]) => `
      <article class="analytics-metric">
        <span>${escapeHtml(name)}</span>
        <strong>${escapeHtml(value)}</strong>
      </article>
    `).join('');
    renderTrend(els.analyticsTrendChart, report.trend);
    renderExceptionSummary(els.analyticsExceptionSummary, report.exceptions);
    renderExceptionList(els.analyticsExceptionList, report.exceptions);
    renderSites(els.analyticsSiteSummary, report.sites);
    renderFormCharts(els.analyticsFormCharts, report.formCharts);
    els.exportManagementCsvButton.disabled = !analyticsReady;
    els.exportManagementHtmlButton.disabled = !analyticsReady;
  }

  function exportCsv() {
    if (!state.supervisorRecords.analyticsReady) {
      renderStatusBanner('Refresh the complete Analytics dataset before exporting.', true);
      return;
    }
    const report = analytics();
    const label = periodLabel(selectedPeriod());
    downloadBlob(
      new Blob([managementCsv(report, label)], { type: 'text/csv;charset=utf-8' }),
      `leader-management-report-${todayDateInput()}.csv`
    );
    renderStatusBanner('Management CSV exported.');
  }

  function exportHtml() {
    if (!state.supervisorRecords.analyticsReady) {
      renderStatusBanner('Refresh the complete Analytics dataset before exporting.', true);
      return;
    }
    const report = analytics();
    const label = periodLabel(selectedPeriod());
    downloadBlob(
      new Blob([managementHtml(report, label)], { type: 'text/html;charset=utf-8' }),
      `leader-management-report-${todayDateInput()}.html`
    );
    renderStatusBanner('Print-ready management report exported.');
  }

  function bindEvents() {
    els.analyticsPeriodSelect.addEventListener('change', renderPanel);
    els.exportManagementCsvButton.addEventListener('click', exportCsv);
    els.exportManagementHtmlButton.addEventListener('click', exportHtml);
    els.managementAnalyticsDetails.addEventListener('toggle', () => {
      if (els.managementAnalyticsDetails.open) renderPanel();
    });
  }

  return {
    bindEvents,
    renderPanel
  };
}
