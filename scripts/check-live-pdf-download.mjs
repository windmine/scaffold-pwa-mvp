import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserApiRequest, showSupervisorFilters } from './check-hosted-report-workflow.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function requireCondition(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

// Existing owned demo Reports only. Credentials remain in process memory;
// all non-auth mutations are blocked. Never overwrite earlier release evidence.
export function readPdfConfiguration(args = process.argv.slice(2), env = process.env) {
  requireCondition(args.length === 4 && args[0] === '--origin' && args[2] === '--evidence-dir'
    && args[3], 'origin_and_new_evidence_directory_required');
  let base;
  try { base = new URL(args[1]); }
  catch { requireCondition(false, 'https_origin_only_required'); }
  requireCondition(base.protocol === 'https:' && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'https_origin_only_required');
  requireCondition(base.host === env.HOSTED_REPORT_ALLOWED_HOST, 'exact_host_allowlist_required');
  const evidenceDir = resolve(args[3]);
  requireCondition(!existsSync(evidenceDir), 'new_evidence_directory_required');
  return { origin: base.origin, evidenceDir };
}

export function pdfRequestAllowed(url, method, origin) {
  const target = new URL(url);
  return target.origin === origin && (['GET', 'HEAD', 'OPTIONS'].includes(method)
    || (method === 'POST' && ['/api/auth/login', '/api/auth/logout', '/api/auth/refresh'].includes(target.pathname)));
}

export function assertPdfDownload(bytes, filename) {
  requireCondition(/\.pdf$/i.test(filename) && bytes.length > 200
    && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    && bytes.subarray(-1024).includes(Buffer.from('%%EOF')), 'invalid_pdf_download');
}

async function main() {
  let config;
  try { config = readPdfConfiguration(); }
  catch (error) {
    console.error(`PDF browser check refused: ${error.safeCode || 'invalid_configuration'}`);
    process.exitCode = 1;
    return;
  }
  const { origin, evidenceDir } = config;
  mkdirSync(dirname(evidenceDir), { recursive: true });
  mkdirSync(evidenceDir);
  const evidenceFile = join(evidenceDir, 'evidence.json');
  const py = "import importlib.util,json; s=importlib.util.spec_from_file_location('demo','scripts/presentation-demo-live.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_private_handoff('demo-20260916')))";
  const evidence = { status: 'running', origin, startedAtUtc: new Date().toISOString(),
    scope: 'Owned demo Reports; no business-data mutations or physical-phone claim',
    viewport: { width: 390, height: 844 }, pageErrors: 0, downloads: [],
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex') };
  let browser;
  let context;
  let page;
  let stage = 'browser_start';
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  try {
    const email = process.env.HOSTED_PDF_SUPERVISOR_EMAIL;
    const password = process.env.HOSTED_PDF_SUPERVISOR_PASSWORD;
    if (email || password) requireCondition(email?.includes('@') && password?.length >= 8, 'supervisor_credentials_required');
    let account;
    try {
      account = email ? { email, password } : JSON.parse(execFileSync('python', ['-c', py], {
        encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      })).accounts.supervisor;
    } catch { requireCondition(false, 'private_supervisor_handoff_unavailable'); }
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: origin, viewport: evidence.viewport,
      isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    context.setDefaultTimeout(45000);
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!pdfRequestAllowed(request.url(), request.method(), origin)) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', () => { evidence.pageErrors += 1; });
    stage = 'demo_supervisor_login';
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.activeView === 'login'
      && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
    await page.locator('#emailInput').fill(account.email);
    await page.locator('#passwordInput').fill(account.password);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(() => document.body.dataset.activeView === 'supervisor');
    await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
    const me = await page.evaluate(browserApiRequest, { path: '/api/auth/me' });
    requireCondition(me.ok && me.body.id === 16 && me.body.department_id === 2
      && !me.body.is_global_admin, 'existing_demo_scope_mismatch');
    stage = 'collection_pdf_primary_action';
    await showSupervisorFilters(page);
    await page.locator('#supervisorStatusFilter').selectOption('');
    await page.locator('#supervisorSearchInput').fill('demo-20260916');
    await page.waitForFunction(() => document.querySelectorAll('#reviewQueueList .record-form').length === 9);
    requireCondition(await page.locator('.report-export-actions').evaluate((group) => {
      const pdf = group.querySelector('#exportReportsPdfButton');
      const csv = group.querySelector('#exportReportsCsvButton');
      return group.querySelector('button') === pdf && !pdf.classList.contains('ghost') && csv.classList.contains('ghost');
    }), 'collection_pdf_not_primary');
    const collectionDownload = page.waitForEvent('download');
    await page.locator('#exportReportsPdfButton').click();
    const collection = await collectionDownload;
    const collectionPath = join(evidenceDir, 'browser-collection.pdf');
    await collection.saveAs(collectionPath);
    const collectionBytes = readFileSync(collectionPath);
    assertPdfDownload(collectionBytes, collection.suggestedFilename());
    evidence.downloads.push({ kind: 'collection', filename: collection.suggestedFilename(), bytes: collectionBytes.length,
      sha256: createHash('sha256').update(collectionBytes).digest('hex'), artifact: 'browser-collection.pdf' });
    evidence.collectionPdfPrimary = true;
    stage = 'single_pdf_default_without_selection';
    await showSupervisorFilters(page);
    // Exact retained T01 ownership from presentation-demo-20260916.json; leave
    // the demo-only collection filter intact while opening its single Report.
    const demoCard = page.locator('#reviewQueueList .record-form[data-record-key="form:5"]');
    requireCondition((await demoCard.innerText()).includes('walkway'), 'owned_demo_report_not_found');
    await demoCard.click();
    const format = page.locator('#reviewQueueActions select');
    requireCondition(await format.inputValue() === 'form-pdf', 'single_report_pdf_not_default');
    requireCondition(await format.locator('option').evaluateAll((options) => {
      const values = options.map((option) => option.value);
      return values[0] === 'form-pdf' && values.includes('form-html') && values.includes('form-csv');
    }), 'alternate_report_formats_missing');
    const singleDownload = page.waitForEvent('download');
    await page.locator('#reviewQueueActions').getByRole('button', { name: 'Download PDF', exact: true }).click();
    const single = await singleDownload;
    const singlePath = join(evidenceDir, 'browser-single.pdf');
    await single.saveAs(singlePath);
    const singleBytes = readFileSync(singlePath);
    assertPdfDownload(singleBytes, single.suggestedFilename());
    evidence.downloads.push({ kind: 'single', filename: single.suggestedFilename(), bytes: singleBytes.length,
      sha256: createHash('sha256').update(singleBytes).digest('hex'), artifact: 'browser-single.pdf' });
    evidence.singlePdfDefaultWithoutSelection = true;
    evidence.alternateFormatsAvailable = ['html', 'csv'];
    if (evidence.pageErrors !== 0 || !await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1)) {
      requireCondition(false, 'browser_layout_or_page_error');
    }
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { checkpoint: stage, code: error.safeCode || 'browser_or_download_operation_failed' };
    process.exitCode = 1;
  } finally {
    if (page) await page.evaluate(browserApiRequest, { path: '/api/auth/logout', method: 'POST' }).catch(() => {});
    if (context) await context.close();
    if (browser) await browser.close();
    evidence.completedAtUtc = new Date().toISOString();
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
