import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { auditStandalone, GENESIS, verifyChain } from '../src/audit/service.js';
import { runSlaTick } from '../src/sla/tick.js';
import { bearer, buildTestApp, resetAuditLog, USERS, WEBHOOK_SECRET, withAuditGuardsOff } from './helpers.js';
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
const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await flushAudit(); };
const rows = async () => (await pool.query('select * from audit_log order by seq')).rows;
const seed = async (n = 6) => {
  for (let i = 0; i < n; i++) await auditStandalone(pool, { actorName: 'tester', action: 'test.event', detail: { i } });
  return rows();
};

beforeEach(async () => {
  await flushAudit();
  await resetAuditLog(pool);
  await pool.query('truncate users, cases restart identity cascade');
});
afterAll(async () => {
  await flushAudit();
  await resetAuditLog(pool); // leave no tampered records behind
  await pool.end();
});

describe('hash chain', () => {
  it('links every record to the previous one and verifies', async () => {
    const all = await seed(5);
    expect(all[0].prev_hash).toBe(GENESIS);
    expect(all[1].prev_hash).toBe(all[0].hash);
    const v = await verifyChain(pool);
    expect(v).toMatchObject({ valid: true, checked: 5 });
    expect(v.head?.hash).toBe(all[4].hash);
  });

  it('keeps one linear chain under concurrent writers', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      auditStandalone(pool, { actorName: 'tester', action: 'test.parallel', detail: { i } })));
    expect(await verifyChain(pool)).toMatchObject({ valid: true, checked: 25 });
  });

  it('an empty log is valid', async () => {
    expect(await verifyChain(pool)).toMatchObject({ valid: true, checked: 0, head: null });
  });
});

describe('append-only', () => {
  it('the database refuses updates, deletes and truncation', async () => {
    await seed(2);
    await expect(pool.query(`update audit_log set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('tamper detection', () => {
  it('detects an edited record', async () => {
    const all = await seed();
    await withAuditGuardsOff(pool, () =>
      pool.query(`update audit_log set detail = '{"i": 99}'::jsonb where seq = $1`, [all[2].seq]));
    const v = await verifyChain(pool);
    expect(v.valid).toBe(false);
    expect(v.brokenAtSeq).toBe(String(all[2].seq));
  });

  it('detects a changed actor', async () => {
    const all = await seed();
    await withAuditGuardsOff(pool, () =>
      pool.query(`update audit_log set actor_name = 'mallory' where seq = $1`, [all[4].seq]));
    expect((await verifyChain(pool)).brokenAtSeq).toBe(String(all[4].seq));
  });

  it('detects a record deleted from the middle', async () => {
    const all = await seed();
    await withAuditGuardsOff(pool, () => pool.query('delete from audit_log where seq = $1', [all[3].seq]));
    const v = await verifyChain(pool);
    expect(v.valid).toBe(false);
    expect(v.brokenAtSeq).toBe(String(all[4].seq));
  });

  it('detects a record deleted from the start', async () => {
    const all = await seed();
    await withAuditGuardsOff(pool, () => pool.query('delete from audit_log where seq = $1', [all[0].seq]));
    expect((await verifyChain(pool)).valid).toBe(false);
  });

  it('detects a forged record', async () => {
    const all = await seed();
    await withAuditGuardsOff(pool, () => pool.query(
      `insert into audit_log (at, actor_name, action, prev_hash, hash) values (now(), 'mallory', 'forged', $1, $2)`,
      [all[all.length - 1].hash, '1'.repeat(64)]));
    expect((await verifyChain(pool)).valid).toBe(false);
  });

  it('a removed tail is caught by a saved head hash (anchor)', async () => {
    const all = await seed(5);
    const head = (await verifyChain(pool)).head!;
    await withAuditGuardsOff(pool, () => pool.query('delete from audit_log where seq = $1', [all[4].seq]));
    const v = await verifyChain(pool, head.hash);
    expect(v.valid).toBe(true);         // what remains is internally consistent
    expect(v.anchorFound).toBe(false);  // but the head we remembered is gone
  });
});

describe('what gets recorded', () => {
  it('records requests with actor, outcome and key fields', async () => {
    const created = await call('post', '/api/cases', T1, { title: 'Audited case', severity: 'low' });
    await call('get', `/api/cases/${created.body.id}`, T1);
    await call('post', `/api/cases/${created.body.id}/transition`, MGR, { to: 'triage' });
    await call('post', '/api/cases', AUD, { title: 'Denied attempt', severity: 'low' });
    await request(app).get('/api/cases');
    await settle();

    const all = await rows();
    const create = all.filter((r) => r.action === 'case.create');
    expect(create.map((r) => r.detail.outcome).sort()).toEqual(['denied', 'ok']);
    const ok = create.find((r) => r.detail.outcome === 'ok')!;
    expect(ok).toMatchObject({ actor_name: 'user-1111', entity: 'case' });
    expect(ok.detail).toMatchObject({ status: 201, title: 'Audited case', method: 'POST' });
    expect(create.find((r) => r.detail.outcome === 'denied')).toMatchObject({ actor_name: 'user-5555' });

    const view = all.find((r) => r.action === 'case.view')!;
    expect(view.entity_id).toBe(created.body.id);
    const transition = all.find((r) => r.action === 'case.transition')!;
    expect(transition.detail).toMatchObject({ to: 'triage', status: 200 });

    const anonymous = all.find((r) => r.actor_name === 'anonymous')!;
    expect(anonymous.detail.status).toBe(401);
    expect((await verifyChain(pool)).valid).toBe(true);
  });

  it('records SIEM ingestion with the SIEM as actor', async () => {
    await request(app).post('/webhooks/alerts/generic').set('X-Webhook-Token', WEBHOOK_SECRET)
      .send({ id: randomUUID(), rule_id: 'R1', rule_name: 'Impossible travel', severity: 'medium', host: 'vpn' });
    const [r] = (await rows()).filter((x) => x.action === 'alert.case_created');
    expect(r.actor_name).toBe('siem:generic');
    expect(r.detail.ruleName).toBe('Impossible travel');
  });

  it('records SLA breaches and automatic escalation', async () => {
    const c = (await call('post', '/api/cases', T1, { title: 'SLA audit case', severity: 'high' })).body;
    await pool.query(
      `update case_sla set respond_warn_at = now() - interval '2 seconds', respond_due = now() - interval '1 second' where case_id = $1`,
      [c.id]);
    await runSlaTick(pool);
    const [r] = (await rows()).filter((x) => x.action === 'sla.breach');
    expect(r.actor_name).toBe('system:sla-worker');
    expect(r.detail).toMatchObject({ target: 'respond', escalated: true });
  });
});

describe('audit endpoints', () => {
  it('are limited to auditors and managers', async () => {
    expect((await call('get', '/api/audit', T1)).status).toBe(403);
    expect((await call('get', '/api/audit/verify', T1)).status).toBe(403);
    const list = await call('get', '/api/audit', AUD);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.entries)).toBe(true);
    const verify = await call('get', '/api/audit/verify', MGR);
    expect(verify.body.valid).toBe(true);
  });
});