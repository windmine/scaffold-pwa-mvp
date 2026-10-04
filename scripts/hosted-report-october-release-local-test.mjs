// Whole-run selector/cleanup rehearsal: loopback-only mock backend, NOT hosted,
// PostgreSQL, Cloud Storage, phone-capacity, or release approval evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOctoberRelease } from './check-hosted-report-october-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(root, 'docs', 'evidence');
const runId = `oct-local-${randomUUID().slice(0, 8)}`;
const evidenceDir = path.resolve(evidenceRoot, runId);
const supervisor = { id: 16, email: 'demo-20260916-supervisor@example.invalid', name: 'Synthetic Supervisor',
  role: 'supervisor', department_id: 2, department_name: 'Mutual', dashboard_department_id: 2,
  is_global_admin: false, status: 'active' };
const reports = [], uploads = new Map(), cursors = new Map(), unexpected = [];
let worker, template, deletionVersion = 0;
const rank = { submitted: 0, in_review: 1, resolved: 2 };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1'), pathname = url.pathname;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = bytes.length && pathname !== '/api/photo-uploads' ? JSON.parse(bytes) : {};
    const json = (body, status = 200, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers });
      response.end(JSON.stringify(body));
    };
    const actor = request.headers.cookie?.includes('oct_actor=supervisor') ? supervisor
      : request.headers.cookie?.includes('oct_actor=worker') ? worker : null;
    const visible = () => reports.filter((row) => !row.deleted);
    if (pathname === '/api/auth/login') {
      const user = body.email === supervisor.email ? supervisor : worker;
      return json({ user }, 200, { 'Set-Cookie': [`oct_actor=${user.role}; Path=/; SameSite=Lax`, 'geo_csrf_token=synthetic; Path=/; SameSite=Lax'] });
    }
    if (['/api/auth/me', '/api/auth/refresh'].includes(pathname)) return actor ? json(actor) : json({ detail: 'Not signed in' }, 401);
    if (pathname === '/api/health/ready') return json({ checks: { database: 'ok', migrations: 'ok', upload_storage: 'ok' },
      details: { upload_storage: { backend: 'gcs' } } }); // Explicitly MOCKED readiness, never cloud proof.
    if (pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (pathname === '/api/sites') return json([]);
    if (pathname === '/api/supervisor/worker-invitations') {
      worker = { ...body, id: 101, role: 'worker', status: 'active', department_name: 'Mutual',
        is_global_admin: false, password_setup_required: true };
      return json({ user: worker, token: 'synthetic-owned-invitation-capability-1234567890' });
    }
    if (pathname === '/api/auth/worker-invitations/accept') { worker.password_setup_required = false; return json({ message: 'Password set' }); }
    if (pathname === '/api/supervisor/users') return json([supervisor, ...(worker ? [worker] : [])]);
    if (pathname === '/api/supervisor/users/101/status') { worker.status = body.status; return json(worker); }
    if (pathname === '/api/supervisor/work-forms') {
      template = { ...body, id: 102, created_by: 16, status: 'active', definition_version: 1 }; return json(template);
    }
    if (pathname === '/api/supervisor/work-forms/102') { template.status = body.status; return json(template); }
    if (pathname === '/api/work-forms') return json(template ? [template] : []);
    if (pathname === '/api/photo-uploads') {
      const name = `/uploads/local-${uploads.size + 1}.png`;
      uploads.set(name, bytes.subarray(bytes.indexOf('\r\n\r\n') + 4, bytes.lastIndexOf('\r\n--')));
      return json({ url: name });
    }
    if (uploads.has(pathname)) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(uploads.get(pathname)); return; }
    if (pathname === '/api/form-submissions') {
      const w = request.headers['x-report-recovery-worker'], d = request.headers['x-report-recovery-department'];
      if ((w !== undefined || d !== undefined) && (w !== '101' || d !== '2')) return json({ detail: { code: 'report_recovery_identity_mismatch' } }, 409);
      let record = reports.find((row) => row.client_submission_id === body.client_submission_id);
      const replay = Boolean(record);
      if (!record) {
        record = { ...body, id: 103 + reports.length, department_id: 2, worker_id: 101, worker_name: worker.name,
          form_name: template.name, fields: template.fields, definition_version: 1, submission_purpose: 'report',
          status: 'pending', workflow_status: 'submitted', created_at: new Date().toISOString(),
          photo_urls: body.photo_urls || [], photo_metadata: body.photo_metadata || [] };
        reports.push(record);
      }
      return json({ ...record, idempotent_replay: replay });
    }
    if (pathname === '/api/my-form-submissions/by-client-id') {
      const key = url.searchParams.get('client_submission_id'), row = reports.find((row) => row.client_submission_id === key);
      return json({ worker_id: 101, department_id: 2, client_submission_id: key,
        status: row ? row.deleted ? 'deleted' : 'submitted' : 'not_found', submission: row && !row.deleted ? row : null });
    }
    if (['/api/my-form-submissions', '/api/supervisor/form-submissions'].includes(pathname)) return json(visible());
    if (pathname === '/api/supervisor/review-queue') {
      const q = Object.fromEntries(url.searchParams), signature = JSON.stringify({ ...q, cursor: undefined });
      const size = Number(q.page_size || 50);
      let snapshot;
      if (q.cursor) {
        snapshot = cursors.get(q.cursor);
        if (!snapshot || snapshot.signature !== signature) return json({ detail: 'Review Queue cursor does not match the active filters' }, 400);
        if (snapshot.deletionVersion !== deletionVersion) return json({ detail: { code: 'report_review_order_changed', message: 'Refresh' } }, 409);
      } else {
        const matching = visible().filter((row) => (!q.form_id || String(row.form_id) === q.form_id)
          && (!q.worker_id || String(row.worker_id) === q.worker_id) && (!q.workflow_status || row.workflow_status === q.workflow_status)
          && (!q.record_date || row.work_date === q.record_date));
        matching.sort((a, b) => q.sort_order === 'oldest_waiting' ? rank[a.workflow_status] - rank[b.workflow_status] || a.id - b.id : b.id - a.id);
        snapshot = { signature, ids: matching.map((row) => row.id), offset: 0, deletionVersion, at: new Date().toISOString() };
      }
      const ids = snapshot.ids.slice(snapshot.offset, snapshot.offset + size), hasMore = snapshot.offset + size < snapshot.ids.length;
      let cursor = null;
      if (hasMore) { cursor = randomUUID(); cursors.set(cursor, { ...snapshot, offset: snapshot.offset + size }); }
      const items = ids.map((id) => ({ ...reports.find((row) => row.id === id), kind: 'form', review_key: `form:${id}`, durability: 'durable', read_only: false }));
      return json({ items, counts: { total: snapshot.ids.length }, summary_counts: { total: visible().length },
        page_size: size, sort_order: q.sort_order || 'newest', has_more: hasMore, next_cursor: cursor, snapshot_at: snapshot.at });
    }
    const transition = pathname.match(/^\/api\/supervisor\/form-submissions\/(\d+)\/transition$/);
    if (transition) {
      const row = reports.find((row) => row.id === Number(transition[1]));
      row.workflow_status = body.status; row.supervisor_note = body.supervisor_note;
      row.review_started_at ||= new Date().toISOString();
      if (body.status === 'resolved') row.resolved_at = new Date().toISOString();
      return json(row);
    }
    const trash = pathname.match(/^\/api\/supervisor\/trash\/form\/(\d+)$/);
    if (trash) { reports.find((row) => row.id === Number(trash[1])).deleted = true; deletionVersion++; return json({ message: 'Trashed' }); }
    if (['/api/supervisor/audit-events', '/api/supervisor/trash'].includes(pathname)) return json([]);
    if (pathname.startsWith('/api/')) { unexpected.push(`${request.method} ${pathname}`); return json({ detail: 'Unexpected mock request' }, 500); }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const filename = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(filename.startsWith(root + path.sep));
    let content = await readFile(filename);
    const extension = path.extname(filename);
    if (extension === '.js') content = content.toString().replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' }); response.end(content);
  } catch (error) {
    unexpected.push(error.code || error.name); response.writeHead(500); response.end('Local fixture failure');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const result = await runOctoberRelease({ runId, baseURL: `http://127.0.0.1:${server.address().port}`,
    evidenceDir, supervisor: { email: supervisor.email, password: 'synthetic-local-test-only' } });
  console.log(JSON.stringify({ status: result.status, checkpoints: result.checks.map((row) => row.name),
    failure: result.failure, cleanup: result.cleanup, unexpected }));
  assert.equal(result.status, 'passed'); assert.deepEqual(unexpected, []);
  assert.equal(reports.length, 2); assert.ok(reports.every((row) => row.deleted));
  assert.equal(template.status, 'archived'); assert.equal(worker.status, 'resigned');
  console.log('PASS - October verifier whole-run local mock rehearsal; no cloud requests');
} finally {
  await new Promise((resolve) => server.close(resolve));
  // Only the exact newly generated test evidence directory may be removed.
  assert.equal(path.dirname(evidenceDir), evidenceRoot);
  assert.match(path.basename(evidenceDir), /^oct-local-[a-f0-9]{8}$/);
  await rm(evidenceDir, { recursive: true, force: true });
}
