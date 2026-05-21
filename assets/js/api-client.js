const TOKEN_KEY = "geo_token";
const USER_KEY = "geo_user";

function getDefaultApiBase() {
  if (window.location.protocol === "https:") {
    return "/api";
  }

  const host = window.location.hostname;

  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:8000";
  }

  return `http://${host}:8000`;
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

function normalizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || user.fullName || user.email,
    fullName: user.fullName || user.name || user.email,
    role: user.role
  };
}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveSession(token, user) {
  saveToken(token);
  localStorage.setItem(USER_KEY, JSON.stringify(normalizeUser(user)));
}

export function getSession() {
  const token = getToken();
  if (!token) return null;

  try {
    const rawUser = localStorage.getItem(USER_KEY);
    return rawUser ? normalizeUser(JSON.parse(rawUser)) : null;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function apiFetch(path, options = {}) {
  const token = getToken();

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
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

export async function login(email, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  saveSession(data.access_token, data.user);

  return normalizeUser(data.user);
}

export async function register(name, email, password) {
  const data = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password })
  });

  saveSession(data.access_token, data.user);

  return normalizeUser(data.user);
}

export async function getCurrentUser() {
  const user = normalizeUser(await apiFetch("/auth/me"));
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function getUsers() {
  return await apiFetch("/supervisor/users");
}

export async function createUser(user) {
  return await apiFetch("/supervisor/users", {
    method: "POST",
    body: JSON.stringify(user)
  });
}

export async function getSites() {
  return await apiFetch("/sites");
}

export async function createSite(site) {
  return await apiFetch("/supervisor/sites", {
    method: "POST",
    body: JSON.stringify(site)
  });
}

export async function uploadPhoto(file, filename = "photo.jpg") {
  const token = getToken();
  const formData = new FormData();
  formData.append("file", file, filename);

  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/photo-uploads`, {
      method: "POST",
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

export async function createTaskLog(log) {
  return await apiFetch("/task-logs", {
    method: "POST",
    body: JSON.stringify(log)
  });
}

export async function getMyTaskLogs() {
  return await apiFetch("/my-task-logs");
}

export async function getPendingRecords() {
  return await apiFetch("/supervisor/pending-records");
}

export async function getSupervisorRecords(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await apiFetch(`/supervisor/records${query}`);
}

export async function exportSupervisorRecordsCsv(status = "") {
  const token = getToken();
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const headers = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/supervisor/records/export.csv${query}`, {
      headers
    });
  } catch (error) {
    throw new ApiError("CSV export failed. Check that FastAPI is running.", {
      cause: error
    });
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new ApiError(error.detail || "CSV export failed", {
      status: res.status
    });
  }

  return await res.blob();
}

export async function getSupervisorTaskLogs() {
  return await apiFetch("/supervisor/task-logs");
}

export async function decideRecord(recordId, status) {
  return await apiFetch(`/supervisor/records/${recordId}/decision`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}
