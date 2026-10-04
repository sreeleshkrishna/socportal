import { keycloak } from './keycloak';

const API = 'http://localhost:4000';

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  await keycloak.updateToken(30);
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${keycloak.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error ?? ''} ${data.message ?? ''}`.trim());
  return data as T;
}