import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { buildOpenApi } from '../src/openapi.js';
import { routes } from '../src/routes.js';
import { bearer, buildTestApp, ISSUER, signingKey, tokenFor, USERS, WEBHOOK_SECRET } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const MGR = { roles: ['soc_manager'], sub: USERS.mgr };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};

beforeEach(async () => {
  await flushAudit();
  await pool.query('truncate users, cases restart identity cascade');
});
afterAll(async () => { await flushAudit(); await pool.end(); });

describe('response hardening', () => {
  it('hides the framework and sends security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['strict-transport-security']).toBeUndefined(); // sent by the TLS gateway
  });

  it('API responses, even errors, are not cacheable', async () => {
    expect((await request(app).get('/api/cases')).headers['cache-control']).toBe('no-store');
    expect((await call('get', '/api/cases', T1)).headers['cache-control']).toBe('no-store');
  });

  it('errors do not leak internals', async () => {
    const bad = await call('get', '/api/cases/not-a-uuid', T1);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|node_modules|\bat\s.+\(/i);
    const missing = await request(app).get('/definitely/not/here');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});

describe('injection attempts', () => {
  const payloads = [`' OR '1'='1`, `'; DROP TABLE cases; --`, `" OR 1=1 --`, `%' OR 1=1 --`, '\\', '%', '_'];

  it.each(payloads)('case search treats %j as plain text', async (p) => {
    await call('post', '/api/cases', T1, { title: 'Normal case title', severity: 'low' });
    const res = await request(app).get('/api/cases').query({ q: p })
      .set('Authorization', await bearer(T1.roles, T1.sub));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect((await pool.query('select count(*)::int as n from cases')).rows[0].n).toBe(1);
  });

  it('rejects injection in filters that must be enums or ids', async () => {
    const auth = await bearer(T1.roles, T1.sub);
    for (const qs of [{ status: "new' OR '1'='1" }, { severity: '1; select 1' }, { assignee: "x' or 1=1" }]) {
      expect((await request(app).get('/api/cases').query(qs).set('Authorization', auth)).status).toBe(400);
    }
  });

  it('indicator and audit searches are parameterised', async () => {
    const auth = await bearer(AUD.roles, AUD.sub);
    const a = await request(app).get('/api/search/iocs').query({ q: `' OR '1'='1` }).set('Authorization', auth);
    expect(a.status).toBe(200);
    expect(a.body.results).toEqual([]);
    const b = await request(app).get('/api/audit').query({ action: `x' OR 1=1 --` }).set('Authorization', auth);
    expect(b.status).toBe(200);
    expect(b.body.entries).toEqual([]);
  });

  it('stores markup as inert text and serves it as JSON (the UI escapes it)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const created = await call('post', '/api/cases', T1, { title: payload, severity: 'low' });
    expect(created.status).toBe(201);
    const res = await call('get', `/api/cases/${created.body.id}`, T1);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.title).toBe(payload);
  });
});

describe('mass assignment', () => {
  it('ignores fields a user must not set when updating a case', async () => {
    const c = (await call('post', '/api/cases', T1, { title: 'Mass assignment', severity: 'low' })).body;
    const res = await call('patch', `/api/cases/${c.id}`, T1, {
      title: 'Changed title', status: 'closed', assigned_to: USERS.mgr, created_by: USERS.mgr, closed_at: '2020-01-01',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Changed title', status: 'new', assigned_to: null, created_by: USERS.t1, closed_at: null });
  });

  it('ignores status and ownership when creating a case', async () => {
    const res = await call('post', '/api/cases', T1, { title: 'Created as closed?', severity: 'low', status: 'closed', created_by: USERS.mgr });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'new', created_by: USERS.t1 });
  });
});

describe('token attacks', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const get = (token: string) => request(app).get('/api/cases').set('Authorization', `Bearer ${token}`);
  const claims = () => ({
    iss: ISSUER, sub: USERS.mgr, realm_access: { roles: ['soc_manager'] }, exp: Math.floor(Date.now() / 1000) + 300,
  });
  const base = () => new SignJWT({ realm_access: { roles: ['soc_manager'] } }).setSubject(USERS.mgr).setIssuer(ISSUER);

  it('rejects alg=none', async () => {
    expect((await get(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`)).status).toBe(401);
  });

  it('rejects a token signed with a different key that claims the same key id', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await base().setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setExpirationTime('5m').sign(privateKey);
    expect((await get(token)).status).toBe(401);
  });

  it('rejects HMAC tokens (algorithm confusion)', async () => {
    const token = await base().setProtectedHeader({ alg: 'HS256', kid: 'test-key' }).setExpirationTime('5m')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    expect((await get(token)).status).toBe(401);
  });

  it('rejects tokens that are not valid yet', async () => {
    const token = await base().setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setNotBefore(Math.floor(Date.now() / 1000) + 3600).setExpirationTime('2h').sign(signingKey);
    expect((await get(token)).status).toBe(401);
  });

  it('rejects a payload edited to add a role', async () => {
    const [h, , s] = (await tokenFor(['tier1_analyst'])).split('.');
    expect((await get(`${h}.${b64(claims())}.${s}`)).status).toBe(401);
  });

  it('rejects other authorization schemes and empty bearers', async () => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Token abc']) {
      expect((await request(app).get('/api/cases').set('Authorization', header)).status).toBe(401);
    }
  });
});

describe('abuse limits', () => {
  it('rejects oversized JSON bodies', async () => {
    const res = await request(app).post('/api/cases').set('Authorization', await bearer(T1.roles, T1.sub))
      .send({ title: 'big body', severity: 'low', description: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });

  it('rejects oversized webhook payloads', async () => {
    const res = await request(app).post('/webhooks/alerts/generic').set('X-Webhook-Token', WEBHOOK_SECRET)
      .send({ id: 'big', rule_id: 'R', rule_name: 'x'.repeat(1_200_000), severity: 'low' });
    expect(res.status).toBe(413);
  });

  it('throttles clients that send too many requests', async () => {
    const limited = buildTestApp(pool, { rateLimitPerMinute: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await request(limited).get('/health')).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  });
});

describe('uploaded files', () => {
  it('serves HTML uploads as an inert attachment', async () => {
    const c = (await call('post', '/api/cases', T1, { title: 'Hostile upload', severity: 'low' })).body;
    const up = await request(app).post(`/api/cases/${c.id}/evidence`)
      .set('Authorization', await bearer(T1.roles, T1.sub))
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.html', contentType: 'text/html' });
    expect(up.status).toBe(201);
    const dl = await call('get', `/api/cases/${c.id}/evidence/${up.body.evidenceId}/versions/1/download`, AUD);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('API documentation', () => {
  const spec = buildOpenApi(routes, 'http://localhost:4000');

  it('documents every route with the permission it requires', () => {
    for (const r of routes) {
      const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
      const op = spec.paths[p]?.[r.method];
      expect(op, `${r.method.toUpperCase()} ${p}`).toBeDefined();
      expect(op['x-required-permission']).toBe(r.permission);
      expect(op.security).toEqual([{ bearerAuth: [] }]);
    }
    expect(spec.paths['/webhooks/alerts/{source}']).toBeDefined();
  });

  it('is served at /openapi.json and never reflects a hostile Host header', async () => {
    const ok = await request(app).get('/openapi.json').set('Host', 'api:4000');
    expect(ok.status).toBe(200);
    expect(ok.body.servers[0].url).toBe('http://api:4000');
    expect(ok.body.components.securitySchemes.bearerAuth).toBeDefined();
    const hostile = await request(app).get('/openapi.json').set('Host', 'bad_host.example');
    expect(hostile.body.servers[0].url).toBe('http://localhost:4000');
  });
});