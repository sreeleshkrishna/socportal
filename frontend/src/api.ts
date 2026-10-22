import { keycloak } from './keycloak';

// "same-origin" is used by the Docker build: the gateway serves the UI and proxies /api
const configured = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const API = configured === 'same-origin' ? '' : configured;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function authHeaders(extra: Record<string, string> = {}) {
  try {
    await keycloak.updateToken(30);
  } catch {
    await keycloak.login(); // the session ended: go back to the sign-in page
  }
  return { Authorization: `Bearer ${keycloak.token}`, ...extra };
}

async function fail(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new ApiError(res.status, data.error ?? 'error', data.message ?? data.error ?? `Request failed (${res.status})`);
}

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: await authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return fail(res);
  return (await res.json().catch(() => ({}))) as T;
}

export async function apiForm<T = unknown>(path: string, form: FormData): Promise<T> {
  const res = await fetch(API + path, { method: 'POST', headers: await authHeaders(), body: form });
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export async function apiFile(path: string): Promise<{ blob: Blob; sha256: string | null }> {
  const res = await fetch(API + path, { headers: await authHeaders() });
  if (!res.ok) return fail(res);
  return { blob: await res.blob(), sha256: res.headers.get('X-Report-SHA256') };
}

export async function apiBlob(path: string): Promise<Blob> {
  return (await apiFile(path)).blob;
}