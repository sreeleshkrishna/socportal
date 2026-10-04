import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';

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

export async function tokenFor(
  roles: string[], opts: { expiresAt?: number; issuer?: string; sub?: string } = {},
) {
  return new SignJWT({ preferred_username: `user-${(opts.sub ?? USERS.t1).slice(0, 4)}`, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(opts.sub ?? USERS.t1)
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

export const bearer = async (roles: string[], sub = USERS.t1) => `Bearer ${await tokenFor(roles, { sub })}`;

export function buildTestApp(pool: Pool) {
  return createApp({ getKey, issuer: ISSUER, corsOrigin: 'http://localhost:5173', db: pool });
}