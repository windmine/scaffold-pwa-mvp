import {
  exportSupervisorFormSubmissionCsv,
  exportSupervisorFormSubmissionHtml,
  exportSupervisorFormSubmissionPdf,
  exportSupervisorFormSubmissionsCsv,
  exportSupervisorFormSubmissionsHtml,
  exportSupervisorFormSubmissionsPdf,
  exportSupervisorRecordsCsv,
  exportSupervisorTaskLogCsv,
  exportSupervisorTaskLogHtml,
  exportSupervisorTaskLogsCsv,
  exportSupervisorTaskLogsHtml
} from './api-client.js';
import { downloadBlob, isDayworkRecord } from './supervisor-review-utils.js';
import { todayDateInput } from './utils.js';


const DEFAULT_OPERATIONS = {
  attendanceCsv: exportSupervisorRecordsCsv,
  taskLogsCsv: exportSupervisorTaskLogsCsv,
  taskLogsHtml: exportSupervisorTaskLogsHtml,
  formSubmissionsCsv: exportSupervisorFormSubmissionsCsv,
  formSubmissionsHtml: exportSupervisorFormSubmissionsHtml,
  formSubmissionsPdf: exportSupervisorFormSubmissionsPdf,
  taskLogCsv: exportSupervisorTaskLogCsv,
  taskLogHtml: exportSupervisorTaskLogHtml,
  formSubmissionCsv: exportSupervisorFormSubmissionCsv,
  formSubmissionHtml: exportSupervisorFormSubmissionHtml,
  formSubmissionPdf: exportSupervisorFormSubmissionPdf
};


export function createReviewExportAdapters(options = {}) {
  const operations = { ...DEFAULT_OPERATIONS, ...(options.operations || {}) };
  const save = options.download || downloadBlob;
  const currentDate = options.currentDate || todayDateInput;

  const formRecordFilename = (record, extension) => {
    const purpose = isDayworkRecord(record) ? 'daywork' : 'report';
    return `leader-${purpose}-${record.backendRecordId}-${currentDate()}.${extension}`;
  };

  async function saveResult(run, filename, message) {
    const blob = await run();
    save(blob, filename);
    return message;
  }

  const collectionAdapters = {
    'attendance-csv': (filters) => saveResult(
      () => operations.attendanceCsv(filters),
      `leader-attendance-${currentDate()}.csv`,
      'Attendance CSV exported.'
    ),
    'task-logs-csv': (filters) => saveResult(
      () => operations.taskLogsCsv(filters),
      `leader-task-logs-${currentDate()}.csv`,
      'Task logs CSV exported.'
    ),
    'task-daily-log': (filters) => saveResult(
      () => operations.taskLogsHtml('daily-log', filters),
      `leader-daily-task-logs-${currentDate()}.html`,
      'Daily task log sheets exported.'
    ),
    'task-photo-report': (filters) => saveResult(
      () => operations.taskLogsHtml('photo-report', filters),
      `leader-task-photo-report-${currentDate()}.html`,
      'Task photo report exported.'
    ),
    'form-submissions': (filters) => saveResult(
      () => operations.formSubmissionsHtml(filters),
      `leader-reports-${currentDate()}.html`,
      'Reports exported.'
    ),
    'form-submissions-csv': (filters) => saveResult(
      () => operations.formSubmissionsCsv(filters),
      `leader-reports-${currentDate()}.csv`,
      'Reports CSV exported.'
    ),
    'form-submissions-pdf': (filters) => saveResult(
      () => operations.formSubmissionsPdf('submitted-form', filters),
      `leader-reports-${currentDate()}.pdf`,
      'Reports PDF exported.'
    ),
    'daywork-pdf': (filters) => saveResult(
      () => operations.formSubmissionsPdf('daywork', filters),
      `leader-daywork-${currentDate()}.pdf`,
      'Daywork PDF exported.'
    )
  };

  const recordAdapters = {
    'task-daily-log-html': (record) => saveResult(
      () => operations.taskLogHtml(record.backendRecordId, 'daily-log'),
      `leader-task-log-${record.backendRecordId}-daily-log-${currentDate()}.html`,
      'Daily task log exported.'
    ),
    'task-photo-report-html': (record) => saveResult(
      () => operations.taskLogHtml(record.backendRecordId, 'photo-report'),
      `leader-task-log-${record.backendRecordId}-photo-report-${currentDate()}.html`,
      'Task photo report exported.'
    ),
    'task-csv': (record) => saveResult(
      () => operations.taskLogCsv(record.backendRecordId),
      `leader-task-log-${record.backendRecordId}-${currentDate()}.csv`,
      'Task log CSV row exported.'
    ),
    'form-html': (record) => saveResult(
      () => operations.formSubmissionHtml(record.backendRecordId),
      formRecordFilename(record, 'html'),
      'Report exported.'
    ),
    'form-pdf': (record) => saveResult(
      () => operations.formSubmissionPdf(record.backendRecordId, 'submitted-form'),
      formRecordFilename(record, 'pdf'),
      'Report PDF exported.'
    ),
    'daywork-pdf': (record) => {
      if (!isDayworkRecord(record)) throw new Error('This submission is not a Daywork form.');
      return saveResult(
        () => operations.formSubmissionPdf(record.backendRecordId, 'daywork'),
        `leader-daywork-${record.backendRecordId}-${currentDate()}.pdf`,
        'Daywork PDF exported.'
      );
    },
    'form-csv': (record) => saveResult(
      () => operations.formSubmissionCsv(record.backendRecordId),
      formRecordFilename(record, 'csv'),
      'Report CSV row exported.'
    )
  };

  return {
    async exportCollection(exportType, filters = {}) {
      const adapter = collectionAdapters[exportType];
      if (!adapter) throw new Error(`Unsupported Review Queue export: ${exportType}`);
      return await adapter(filters);
    },

    async exportRecord(record, exportType) {
      if (
        !record?.backendRecordId
        || record.durability !== 'durable'
        || record.readOnly
      ) {
        throw new Error('Only durable backend Review Records can be exported.');
      }
      const adapter = recordAdapters[exportType];
      if (!adapter) throw new Error(`Unsupported Review Record export: ${exportType}`);
      return await adapter(record);
    }
  };
}
