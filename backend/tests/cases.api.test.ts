import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, buildTestApp, USERS } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const T2  = { roles: ['tier2_analyst'], sub: USERS.t2 };
const IR  = { roles: ['incident_responder'], sub: USERS.ir };
const MGR = { roles: ['soc_manager'], sub: USERS.mgr };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const newCase = async (who: Who = T1, severity = 'high') =>
  (await call('post', '/api/cases', who, { title: 'Test case', severity })).body;
const move = (id: string, who: Who, body: object) => call('post', `/api/cases/${id}/transition`, who, body);

beforeEach(async () => {
  await pool.query('truncate users, cases restart identity cascade');
});
afterAll(() => pool.end());

describe('create and read', () => {
  it('creates a case in status new', async () => {
    const res = await call('post', '/api/cases', T1, { title: 'Phishing email', severity: 'medium' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('new');
    expect(res.body.created_by).toBe(USERS.t1);
  });

  it('validates input', async () => {
    expect((await call('post', '/api/cases', T1, { title: 'ab', severity: 'high' })).status).toBe(400);
    expect((await call('post', '/api/cases', T1, { title: 'Valid title', severity: 'bogus' })).status).toBe(400);
  });

  it('auditor can read but not create', async () => {
    expect((await call('post', '/api/cases', AUD, { title: 'Nope nope', severity: 'low' })).status).toBe(403);
    expect((await call('get', '/api/cases', AUD)).status).toBe(200);
  });

  it('returns 400 for a bad id and 404 for an unknown one', async () => {
    expect((await call('get', '/api/cases/not-a-uuid', T1)).status).toBe(400);
    expect((await call('get', '/api/cases/99999999-9999-4999-8999-999999999999', T1)).status).toBe(404);
  });

  it('filters the list', async () => {
    await newCase(T1, 'low'); await newCase(T1, 'critical'); await newCase(T1, 'critical');
    const res = await call('get', '/api/cases?severity=critical', T1);
    expect(res.body.total).toBe(2);
  });

  it('allowedTransitions depends on role', async () => {
    const c = await newCase();
    const t1 = (await call('get', `/api/cases/${c.id}`, T1)).body.allowedTransitions.map((t: { to: string }) => t.to);
    const aud = (await call('get', `/api/cases/${c.id}`, AUD)).body.allowedTransitions;
    expect(t1).toEqual(['triage']);
    expect(aud).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('walks a case through every state', async () => {
    const c = await newCase();
    expect((await move(c.id, MGR, { to: 'triage' })).body.status).toBe('triage');
    expect((await move(c.id, MGR, { to: 'in_progress' })).body.status).toBe('in_progress');
    expect((await move(c.id, MGR, { to: 'escalated' })).status).toBe(400); // reason missing
    expect((await move(c.id, MGR, { to: 'escalated', reason: 'Needs IR' })).body.status).toBe('escalated');
    expect((await move(c.id, MGR, { to: 'contained' })).body.status).toBe('contained');
    expect((await move(c.id, MGR, { to: 'resolved', summary: 'Cleaned' })).body.status).toBe('resolved');
    const closed = await move(c.id, MGR, { to: 'closed' });
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closed_at).not.toBeNull();

    const detail = (await call('get', `/api/cases/${c.id}`, MGR)).body;
    expect(detail.events).toHaveLength(7); // created + 6 status changes
    expect((await move(c.id, MGR, { to: 'in_progress', reason: 'reopen' })).status).toBe(409);
    expect((await call('patch', `/api/cases/${c.id}`, MGR, { title: 'Changed title' })).status).toBe(409);
  });

  it('rejects skipping states', async () => {
    const c = await newCase();
    const res = await move(c.id, MGR, { to: 'resolved', summary: 'x'.repeat(5) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_transition');
  });

  it('triage claims an unassigned case; tier 1 cannot close', async () => {
    const c = await newCase();
    expect((await move(c.id, T1, { to: 'triage' })).body.assigned_to).toBe(USERS.t1);
    await move(c.id, T1, { to: 'in_progress' });
    await move(c.id, T1, { to: 'contained' });
    await move(c.id, T1, { to: 'resolved', summary: 'Done here' });
    expect((await call('post', `/api/cases/${c.id}/close`, T1)).status).toBe(403);
    expect((await call('post', `/api/cases/${c.id}/close`, IR)).status).toBe(200);
  });
});

describe('assignment and notes', () => {
  it('tier 2 can assign to a known user; tier 1 cannot', async () => {
    const c = await newCase();
    await call('get', '/api/me', MGR); // makes the manager exist in users
    expect((await call('post', `/api/cases/${c.id}/assign`, T1, { assigneeId: USERS.mgr })).status).toBe(403);
    const ok = await call('post', `/api/cases/${c.id}/assign`, T2, { assigneeId: USERS.mgr });
    expect(ok.status).toBe(200);
    expect(ok.body.assigned_to).toBe(USERS.mgr);
    const unknown = await call('post', `/api/cases/${c.id}/assign`, T2, { assigneeId: '66666666-6666-4666-8666-666666666666' });
    expect(unknown.status).toBe(400);
  });

  it('adds notes that show up in the case', async () => {
    const c = await newCase();
    expect((await call('post', `/api/cases/${c.id}/notes`, T1, { body: 'Checked the logs' })).status).toBe(201);
    const detail = (await call('get', `/api/cases/${c.id}`, T1)).body;
    expect(detail.notes).toHaveLength(1);
  });
});