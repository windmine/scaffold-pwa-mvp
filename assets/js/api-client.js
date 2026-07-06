const USER_KEY = "geo_user";
const LEGACY_TOKEN_KEY = "geo_token";
const CSRF_COOKIE_KEY = "geo_csrf_token";
const CSRF_HEADER_KEY = "X-CSRF-Token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function getDefaultApiBase() {
  if (["http:", "https:"].includes(window.location.protocol)) {
    return "/api";
  }

  return "http://127.0.0.1:8000";
}

function getStoredApiBase() {
  const storedApiBase = localStorage.getItem("geo_api_base");

  if (window.location.protocol === "https:" && storedApiBase?.startsWith("http://")) {
    return "";
  }

  return storedApiBase;
}

const API_BASE = getStoredApiBase() || getDefaultApiBase();

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.cause = options.cause;
  }
}

function clearLegacyBearerToken() {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function getCookieValue(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  return document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function csrfHeadersFor(method = "GET") {
  if (SAFE_METHODS.has(String(method || "GET").toUpperCase())) return {};

  const token = getCookieValue(CSRF_COOKIE_KEY);
  return token ? { [CSRF_HEADER_KEY]: decodeURIComponent(token) } : {};
}

function normalizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || user.fullName || user.email,
    fullName: user.fullName || user.name || user.email,
    role: user.role,
    workerClass: user.worker_class || user.workerClass || (user.role === "worker" ? "normal" : null),
    status: user.status || "active",
    departmentId: user.department_id || user.departmentId || null,
    departmentName: user.department_name || user.departmentName || "",
    dashboardDepartmentId: user.dashboard_department_id ?? user.dashboardDepartmentId ?? null,
    dashboardDepartmentName: user.dashboard_department_name || user.dashboardDepartmentName || "",
    isGlobalAdmin: Boolean(user.is_global_admin || user.isGlobalAdmin)
  };
}

export function saveSession(user) {
  clearLegacyBearerToken();
  localStorage.setItem(USER_KEY, JSON.stringify(normalizeUser(user)));
}

export function getSession() {
  clearLegacyBearerToken();

  try {
    const rawUser = localStorage.getItem(USER_KEY);
    return rawUser ? normalizeUser(JSON.parse(rawUser)) : null;
  } catch {
    return null;
  }
}

export function logout() {
  fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: csrfHeadersFor("POST")
  }).catch(() => {});

  clearLegacyBearerToken();
  localStorage.removeItem(USER_KEY);
}

async function apiFetch(path, options = {}) {
  const method = options.method || "GET";

  const headers = {
    "Content-Type": "application/json",
    ...csrfHeadersFor(method),
    ...(options.headers || {})
  };

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers
    });
  } catch (error) {
    throw new ApiError("Backend is unreachable. Check that FastAPI is running.", {
      cause: error
    });
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new ApiError(error.detail || "API request failed", {
      status: res.status
    });
  }

  return await res.json();
}

async function apiBlob(path, fallbackMessage) {
  const headers = {};

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers
    });
  } catch (error) {
    throw new ApiError(`${fallbackMessage} Check that FastAPI is running.`, {
      cause: error
    });
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new ApiError(error.detail || fallbackMessage, {
      status: res.status
    });
  }

  return await res.blob();
}

export async function login(email, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  saveSession(data.user);

  return normalizeUser(data.user);
}

export async function startRegistration(name, email) {
  return await apiFetch("/auth/registration/start", {
    method: "POST",
    body: JSON.stringify({ name, email })
  });
}

export async function verifyRegistration(verificationId, code) {
  return await apiFetch("/auth/registration/verify", {
    method: "POST",
    body: JSON.stringify({
      verification_id: verificationId,
      code
    })
  });
}

export async function register(verificationToken, password, departmentId) {
  const data = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      verification_token: verificationToken,
      password,
      department_id: departmentId
    })
  });

  return {
    user: normalizeUser(data.user),
    message: data.message
  };
}

export async function getCurrentUser() {
  const user = normalizeUser(await apiFetch("/auth/me"));
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function updateDefaultDepartment(departmentId) {
  const user = normalizeUser(await apiFetch("/auth/default-department", {
    method: "PATCH",
    body: JSON.stringify({ department_id: departmentId || null })
  }));
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function getUsers() {
  return await apiFetch("/supervisor/users");
}

export async function getDepartments() {
  return await apiFetch("/departments");
}

export async function createUser(user) {
  return await apiFetch("/supervisor/users", {
    method: "POST",
    body: JSON.stringify(user)
  });
}

export async function updateUser(userId, user) {
  return await apiFetch(`/supervisor/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...user, confirmed: true })
  });
}

export async function updateUserStatus(userId, status) {
  return await apiFetch(`/supervisor/users/${userId}/status`, {
    method: "POST",
    body: JSON.stringify({ status, confirmed: true })
  });
}

export async function getSupervisorAuditEvents(limit = 50) {
  const query = `?limit=${encodeURIComponent(limit)}`;
  return await apiFetch(`/supervisor/audit-events${query}`);
}

export async function getSites() {
  return await apiFetch("/sites");
}

export async function createWorkerSite(site) {
  return await apiFetch("/sites", {
    method: "POST",
    body: JSON.stringify(site)
  });
}

export async function createSite(site) {
  return await apiFetch("/supervisor/sites", {
    method: "POST",
    body: JSON.stringify(site)
  });
}

export async function updateSite(siteId, site) {
  return await apiFetch(`/supervisor/sites/${siteId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...site, confirmed: true })
  });
}

export async function uploadPhoto(file, filename = "photo.jpg") {
  const formData = new FormData();
  formData.append("file", file, filename);

  const headers = csrfHeadersFor("POST");

  let res;
  try {
    res = await fetch(`${API_BASE}/photo-uploads`, {
      method: "POST",
      credentials: "include",
      headers,
      body: formData
    });
  } catch (error) {
    throw new ApiError("Photo upload failed. Check that FastAPI is running.", {
      cause: error
    });
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new ApiError(error.detail || "Photo upload failed", {
      status: res.status
    });
  }

  return await res.json();
}

export async function createAttendance(record) {
  return await apiFetch("/attendance", {
    method: "POST",
    body: JSON.stringify(record)
  });
}

export async function getMyRecords() {
  return await apiFetch("/my-records");
}

export async function updateMyRecord(recordId, record) {
  return await apiFetch(`/my-records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(record)
  });
}

export async function deleteMyRecord(recordId) {
  return await apiFetch(`/my-records/${recordId}`, {
    method: "DELETE"
  });
}

export async function createTaskLog(log) {
  return await apiFetch("/task-logs", {
    method: "POST",
    body: JSON.stringify(log)
  });
}

export async function getMyTaskLogs() {
  return await apiFetch("/my-task-logs");
}

export async function getTeamWorkLogMembers() {
  return await apiFetch("/team-work-log-members");
}

export async function createTeamWorkLog(log) {
  return await apiFetch("/team-work-logs", {
    method: "POST",
    body: JSON.stringify(log)
  });
}

export async function getMyTeamWorkLogs() {
  return await apiFetch("/my-team-work-logs");
}

export async function getSupervisorTeamWorkLogs(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await apiFetch(`/supervisor/team-work-logs${query}`);
}

export async function updateSupervisorTeamWorkLog(logId, log) {
  return await apiFetch(`/supervisor/team-work-logs/${logId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...log, confirmed: true })
  });
}

export async function updateMyTaskLog(logId, log) {
  return await apiFetch(`/my-task-logs/${logId}`, {
    method: "PATCH",
    body: JSON.stringify(log)
  });
}

export async function deleteMyTaskLog(logId) {
  return await apiFetch(`/my-task-logs/${logId}`, {
    method: "DELETE"
  });
}

export async function getTaskTemplates() {
  return await apiFetch("/task-templates");
}

export async function createTaskTemplate(template) {
  return await apiFetch("/task-templates", {
    method: "POST",
    body: JSON.stringify(template)
  });
}

export async function updateTaskTemplate(templateId, template) {
  return await apiFetch(`/task-templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(template)
  });
}

export async function deleteTaskTemplate(templateId) {
  return await apiFetch(`/task-templates/${templateId}`, {
    method: "DELETE"
  });
}

export async function getWorkForms() {
  return await apiFetch("/work-forms");
}

export async function createWorkForm(form) {
  return await apiFetch("/supervisor/work-forms", {
    method: "POST",
    body: JSON.stringify(form)
  });
}

export async function updateWorkForm(formId, form) {
  return await apiFetch(`/supervisor/work-forms/${formId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...form, confirmed: true })
  });
}

export async function createFormSubmission(submission) {
  return await apiFetch("/form-submissions", {
    method: "POST",
    body: JSON.stringify(submission)
  });
}

export async function createSupervisorFormSubmission(submission) {
  return await apiFetch("/supervisor/form-submissions", {
    method: "POST",
    body: JSON.stringify({ ...submission, confirmed: true })
  });
}

export async function getMyFormSubmissions() {
  return await apiFetch("/my-form-submissions");
}

export async function getSupervisorFormSubmissions() {
  return await apiFetch("/supervisor/form-submissions");
}

export async function getPendingRecords() {
  return await apiFetch("/supervisor/pending-records");
}

export async function getSupervisorRecords(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await apiFetch(`/supervisor/records${query}`);
}

export async function createSupervisorAttendance(record) {
  return await apiFetch("/supervisor/records", {
    method: "POST",
    body: JSON.stringify({ ...record, confirmed: true })
  });
}

function exportFilterParams(filters = {}) {
  const normalizedFilters = typeof filters === "string" ? { status: filters } : (filters || {});
  const params = new URLSearchParams();
  if (normalizedFilters.status) params.set("status", normalizedFilters.status);
  if (normalizedFilters.dateFrom) params.set("date_from", normalizedFilters.dateFrom);
  if (normalizedFilters.dateTo) params.set("date_to", normalizedFilters.dateTo);
  if (normalizedFilters.formId) params.set("form_id", normalizedFilters.formId);
  if (normalizedFilters.departmentId) params.set("department_id", normalizedFilters.departmentId);
  return params;
}

function queryString(params) {
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function getSupervisorReviewRecords(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await apiFetch(`/supervisor/review-records${query}`);
}

export async function exportSupervisorRecordsCsv(filters = {}) {
  const query = queryString(exportFilterParams(filters));
  return await apiBlob(`/supervisor/records/export.csv${query}`, "CSV export failed.");
}

export async function getSupervisorTaskLogs() {
  return await apiFetch("/supervisor/task-logs");
}

export async function createSupervisorTaskLog(log) {
  return await apiFetch("/supervisor/task-logs", {
    method: "POST",
    body: JSON.stringify({ ...log, confirmed: true })
  });
}

export async function exportSupervisorTaskLogsCsv(filters = {}) {
  const query = queryString(exportFilterParams(filters));
  return await apiBlob(`/supervisor/task-logs/export.csv${query}`, "Task-log CSV export failed.");
}

export async function exportSupervisorTaskLogsHtml(layout = "daily-log", filters = {}) {
  const params = new URLSearchParams({ layout });
  exportFilterParams(filters).forEach((value, key) => params.set(key, value));
  return await apiBlob(`/supervisor/task-logs/export.html?${params.toString()}`, "Task-log document export failed.");
}

export async function exportSupervisorTaskLogCsv(logId) {
  return await apiBlob(`/supervisor/task-logs/${logId}/export.csv`, "Task-log CSV export failed.");
}

export async function exportSupervisorTaskLogHtml(logId, layout = "daily-log") {
  const params = new URLSearchParams({ layout });
  return await apiBlob(`/supervisor/task-logs/${logId}/export.html?${params.toString()}`, "Task-log document export failed.");
}

export async function exportSupervisorFormSubmissionsHtml(filters = {}) {
  const query = queryString(exportFilterParams(filters));
  return await apiBlob(`/supervisor/form-submissions/export.html${query}`, "Form submission document export failed.");
}

export async function exportSupervisorFormSubmissionsCsv(filters = {}) {
  const query = queryString(exportFilterParams(filters));
  return await apiBlob(`/supervisor/form-submissions/export.csv${query}`, "Form submission CSV export failed.");
}

export async function exportSupervisorFormSubmissionsPdf(template = "submitted-form", filters = {}) {
  const params = new URLSearchParams({ template });
  exportFilterParams(filters).forEach((value, key) => params.set(key, value));
  return await apiBlob(`/supervisor/form-submissions/export.pdf?${params.toString()}`, "Form submission PDF export failed.");
}

export async function exportSupervisorFormSubmissionCsv(submissionId) {
  return await apiBlob(`/supervisor/form-submissions/${submissionId}/export.csv`, "Form submission CSV export failed.");
}

export async function exportSupervisorFormSubmissionHtml(submissionId) {
  return await apiBlob(`/supervisor/form-submissions/${submissionId}/export.html`, "Form submission document export failed.");
}

export async function exportSupervisorFormSubmissionPdf(submissionId, template = "submitted-form") {
  const params = new URLSearchParams({ template });
  return await apiBlob(`/supervisor/form-submissions/${submissionId}/export.pdf?${params.toString()}`, "Form submission PDF export failed.");
}

export async function updateSupervisorFormSubmission(submissionId, submission) {
  return await apiFetch(`/supervisor/form-submissions/${submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...submission, confirmed: true })
  });
}

export async function decideRecord(recordId, status, recordType = "attendance") {
  return await apiFetch(`/supervisor/review-records/${recordType}/${recordId}/decision`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

export async function updateSupervisorRecord(recordId, record) {
  return await apiFetch(`/supervisor/records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...record, confirmed: true })
  });
}

export async function updateSupervisorTaskLog(logId, log) {
  return await apiFetch(`/supervisor/task-logs/${logId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...log, confirmed: true })
  });
}

export async function getSupervisorTrash() {
  return await apiFetch("/supervisor/trash");
}

export async function moveSupervisorRecordToTrash(recordType, recordId, reason) {
  return await apiFetch(`/supervisor/trash/${recordType}/${recordId}`, {
    method: "POST",
    body: JSON.stringify({ reason, confirmed: true })
  });
}

export async function restoreSupervisorRecord(recordType, recordId) {
  return await apiFetch(`/supervisor/trash/${recordType}/${recordId}/restore`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true })
  });
}
