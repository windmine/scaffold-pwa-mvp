import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Never import a script that might launch a browser or read private credentials.
const source = readFileSync(new URL('./check-live-pdf-download.mjs', import.meta.url), 'utf8');
assert.match(source, /if \(process\.argv\[1\].*=== scriptPath\) await main\(\);/,
  'PDF verification must be import-safe before local tests load its helpers');
const { readPdfConfiguration, assertPdfDownload, pdfRequestAllowed } = await import('./check-live-pdf-download.mjs');
const args = ['--origin', 'https://pdf-test.invalid', '--evidence-dir', 'output/pdf/test-never-created'];
const env = { HOSTED_REPORT_ALLOWED_HOST: 'pdf-test.invalid' };
assert.deepEqual(readPdfConfiguration(args, env), {
  origin: 'https://pdf-test.invalid', evidenceDir: resolve('output/pdf/test-never-created')
});
for (const invalid of [[], args.slice(0, 2), [...args, '--extra']]) {
  assert.throws(() => readPdfConfiguration(invalid, env), /origin_and_new_evidence_directory_required/);
}
assert.throws(() => readPdfConfiguration(args, {}), /exact_host_allowlist_required/);
assert.throws(() => readPdfConfiguration(['--origin', 'http://pdf-test.invalid', '--evidence-dir', 'output/pdf/test-never-created'], env), /https_origin_only_required/);
assert.throws(() => readPdfConfiguration(['--origin', 'https://user:secret@pdf-test.invalid', '--evidence-dir', 'output/pdf/test-never-created'], env), /https_origin_only_required/);
assert.throws(() => readPdfConfiguration(['--origin', 'https://pdf-test.invalid', '--evidence-dir', '.'], env), /new_evidence_directory_required/);
console.log('ok - PDF runner requires an explicit HTTPS allowlisted origin and a new output directory');

const pdf = Buffer.from(`%PDF-1.7\n${' '.repeat(250)}\n%%EOF\n`);
assert.doesNotThrow(() => assertPdfDownload(pdf, 'Report.pdf'));
for (const [bytes, name] of [[Buffer.from('<html>Error</html>'), 'Report.pdf'], [pdf, 'Report.html'], [pdf.subarray(0, 100), 'Report.pdf']]) {
  assert.throws(() => assertPdfDownload(bytes, name), /invalid_pdf_download/);
}
console.log('ok - PDF download validation rejects HTML, truncation and incorrect filename extensions');

assert.equal(pdfRequestAllowed('https://pdf-test.invalid/api/reports.pdf', 'GET', 'https://pdf-test.invalid'), true);
assert.equal(pdfRequestAllowed('https://pdf-test.invalid/api/auth/login', 'POST', 'https://pdf-test.invalid'), true);
assert.equal(pdfRequestAllowed('https://pdf-test.invalid/api/supervisor/work-forms', 'POST', 'https://pdf-test.invalid'), false);
assert.equal(pdfRequestAllowed('https://other.invalid/api/auth/login', 'POST', 'https://pdf-test.invalid'), false);
assert.equal(pdfRequestAllowed('https://pdf-test.invalid/api/auth/login', 'DELETE', 'https://pdf-test.invalid'), false);
console.log('ok - PDF verification blocks cross-origin traffic and every non-auth mutation');
console.log('3 PDF runner checks passed; no browser or private credentials accessed');
