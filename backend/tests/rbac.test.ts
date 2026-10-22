import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { can, ROLES } from '../src/auth/permissions.js';
import { routes } from '../src/routes.js';
import { buildTestApp, tokenFor } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);
const ID = '99999999-9999-4999-8999-999999999999';
const url = (p: string) =>
  p.replace(':id', ID).replace(':evidenceId', ID).replace(':iocId', ID).replace(':techniqueId', 'T1110').replace(':version', '1');
const send = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request(app)[method](url(path));
afterAll(() => pool.end());

describe('public endpoints', () => {
  it('GET /health is open', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('authentication', () => {
  it.each(routes)('$method $path rejects missing token', async (r) => {
    expect((await send(r.method, r.path)).status).toBe(401);
  });

  it('rejects garbage, expired and wrong-issuer tokens', async () => {
    const bad = [
      'garbage',
      await tokenFor(['soc_manager'], { expiresAt: Math.floor(Date.now() / 1000) - 60 }),
      await tokenFor(['soc_manager'], { issuer: 'http://evil.local/realms/x' }),
    ];
    for (const t of bad) {
      const res = await request(app).get('/api/cases').set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(401);
    }
  });

  it('GET /api/me returns the user and only known roles', async () => {
    const t = await tokenFor(['auditor', 'made_up_role']);
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['auditor']);
  });
});

describe('authorization: every route x every role', () => {
  for (const r of routes) {
    for (const role of ROLES) {
      const allowed = can([role], r.permission);
      it(`${role} ${allowed ? 'CAN' : 'CANNOT'} ${r.method.toUpperCase()} ${r.path}`, async () => {
        const t = await tokenFor([role]);
        const res = await send(r.method, r.path).set('Authorization', `Bearer ${t}`);
        if (allowed) expect([401, 403]).not.toContain(res.status);
        else expect(res.status).toBe(403);
      });
    }
  }

  it.each(routes)('user with no roles gets 403 on $method $path', async (r) => {
    const t = await tokenFor([]);
    expect((await send(r.method, r.path).set('Authorization', `Bearer ${t}`)).status).toBe(403);
  });
});