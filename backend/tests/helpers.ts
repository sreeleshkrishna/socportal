import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { ObjectStore } from '../src/evidence/storage.js';

export const ISSUER = 'http://test.local/realms/soc';

export const USERS = {
  t1:  '11111111-1111-4111-8111-111111111111',
  t2:  '22222222-2222-4222-8222-222222222222',
  ir:  '33333333-3333-4333-8333-333333333333',
  mgr: '44444444-4444-4444-8444-444444444444',
  aud: '55555555-5555-4555-8555-555555555555',
};

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
export const getKey = createLocalJWKSet({ keys: [jwk] });
export const signingKey = privateKey;

export async function tokenFor(
  roles: string[], opts: { expiresAt?: number; issuer?: string; sub?: string } = {},
) {
  const username = `user-${(opts.sub ?? USERS.t1).slice(0, 4)}`;
  return new SignJWT({ preferred_username: username, email: `${username}@test.local`, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(opts.sub ?? USERS.t1)
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

export const bearer = async (roles: string[], sub = USERS.t1) => `Bearer ${await tokenFor(roles, { sub })}`;

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
export const TEST_EVIDENCE_KEY = randomBytes(32);

export interface MemoryStore extends ObjectStore { objects: Map<string, Buffer> }

export function memoryStore(): MemoryStore {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body) { objects.set(key, Buffer.from(body)); },
    async get(key) {
      const b = objects.get(key);
      if (!b) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
      return Buffer.from(b);
    },
  };
}

export function buildTestApp(
  pool: Pool,
  opts: { store?: ObjectStore; maxUploadBytes?: number; rateLimitPerMinute?: number } = {},
) {
  return createApp({
    getKey, issuer: ISSUER, corsOrigin: 'http://localhost:5173', db: pool,
    webhookSecret: WEBHOOK_SECRET, mergeWindowMinutes: 60,
    store: opts.store ?? memoryStore(), evidenceKey: TEST_EVIDENCE_KEY,
    maxUploadBytes: opts.maxUploadBytes, viewCoalesceSeconds: 0,
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 100000,
  });
}

// Only the table owner can switch the guard triggers off: the tests use this to simulate an attacker
export async function withAuditGuardsOff<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  await pool.query('alter table audit_log disable trigger user');
  try { return await fn(); } finally { await pool.query('alter table audit_log enable trigger user'); }
}

export const resetAuditLog = (pool: Pool) =>
  withAuditGuardsOff(pool, () => pool.query('truncate audit_log restart identity'));