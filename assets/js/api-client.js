const API_BASE = "http://127.0.0.1:8000";

export function saveToken(token) {
  localStorage.setItem("geo_token", token);
}

export function getToken() {
  return localStorage.getItem("geo_token");
}

export function logout() {
  localStorage.removeItem("geo_token");
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

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail || "API request failed");
  }

  return await res.json();
}

export async function login(email, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  saveToken(data.access_token);

  return data.user;
}

export async function getCurrentUser() {
  return await apiFetch("/auth/me");
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

export async function getPendingRecords() {
  return await apiFetch("/supervisor/pending-records");
}

export async function decideRecord(recordId, status) {
  return await apiFetch(`/supervisor/records/${recordId}/decision`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}