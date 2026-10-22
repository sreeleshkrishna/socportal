import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { bearer, buildTestApp, USERS, WEBHOOK_SECRET } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const T2  = { roles: ['tier2_analyst'], sub: USERS.t2 };
const MGR = { roles: ['soc_manager'], sub: USERS.mgr };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;

const call = async (method: 'get' | 'post', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const newCase = async () => (await call('post', '/api/cases', T1, { title: 'Dashboard case', severity: 'high' })).body;

// Moves a case into the past with exact SLA timestamps so the metrics are predictable
const setTimes = (id: string, hoursAgo: number, o: {
  status?: string; respondedMin?: number | null; resolvedMin?: number | null;
  respondDueMin?: number; resolveDueMin?: number;
}) =>
  pool.query(
    `with c as (
       update cases set created_at = now() - make_interval(hours => $2::int), status = $3 where id = $1
       returning created_at)
     update case_sla s set
       respond_due = c.created_at + make_interval(mins => $4::int),
       resolve_due = c.created_at + make_interval(mins => $5::int),
       responded_at = case when $6::int is null then null else c.created_at + make_interval(mins => $6::int) end,
       resolved_at  = case when $7::int is null then null else c.created_at + make_interval(mins => $7::int) end
     from c where s.case_id = $1`,
    [id, hoursAgo, o.status ?? 'new', o.respondDueMin ?? 30, o.resolveDueMin ?? 480, o.respondedMin ?? null, o.resolvedMin ?? null]);

beforeEach(async () => {
  await flushAudit();
  await pool.query('truncate users, cases restart identity cascade');
});
afterAll(async () => { await flushAudit(); await pool.end(); });

describe('dashboard metrics', () => {
  it('computes MTTA, MTTR, SLA compliance, backlog and workload', async () => {
    const a = await newCase();
    const b = await newCase();
    const c = await newCase();
    await setTimes(a.id, 10, { status: 'closed',   respondedMin: 10, resolvedMin: 120 }); // both targets met
    await setTimes(b.id, 10, { status: 'resolved', respondedMin: 50, resolvedMin: 240 }); // responded late
    await setTimes(c.id, 5,  { status: 'new' });                                          // no response, past due
    await call('get', '/api/me', T2); // registers the analyst
    await pool.query('update cases set assigned_to = $1 where id = $2', [USERS.t2, c.id]);

    const res = await call('get', '/api/dashboard?days=30', MGR);
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.kpis).toMatchObject({ created: 3, resolved: 2, mttrSeconds: 10800, mttaSeconds: 1800, mttdSamples: 0 });
    expect(d.kpis.mttdSeconds).toBeNull();
    expect(d.sla.respond).toEqual({ met: 1, missed: 2, compliancePercent: 33.3 });
    expect(d.sla.resolve).toEqual({ met: 2, missed: 0, compliancePercent: 100 });
    expect(d.backlog).toMatchObject({ open: 1, unassigned: 0, overdue: 1 });
    expect(d.backlog.oldestSeconds).toBeGreaterThan(17900);
    expect(d.backlog.oldestSeconds).toBeLessThan(18300);
    expect(d.backlog.byStatus.find((s: { status: string }) => s.status === 'new').count).toBe(1);
    expect(d.backlog.bySeverity.find((s: { severity: string }) => s.severity === 'high').count).toBe(1);
    expect(d.workload).toEqual([{ username: 'user-2222', open: 1, openHigh: 1, overdue: 1, resolvedInPeriod: 0 }]);
    expect(d.severity.find((s: { severity: string }) => s.severity === 'high').count).toBe(3);
  });

  it('measures detection time from the alert event time', async () => {
    await request(app).post('/webhooks/alerts/generic').set('X-Webhook-Token', WEBHOOK_SECRET).send({
      id: randomUUID(), rule_id: 'R9', rule_name: 'MTTD probe', severity: 'low', host: 'h1',
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    const d = (await call('get', '/api/dashboard?days=7', MGR)).body;
    expect(d.kpis.mttdSamples).toBe(1);
    expect(d.kpis.mttdSeconds).toBeGreaterThan(115);
    expect(d.kpis.mttdSeconds).toBeLessThan(140);
  });

  it('returns one trend point per day that adds up to the cases created', async () => {
    await newCase(); await newCase();
    const d = (await call('get', '/api/dashboard?days=7', AUD)).body;
    expect(d.trend).toHaveLength(7);
    expect(d.trend.reduce((s: number, p: { created: number }) => s + p.created, 0)).toBe(2);
  });

  it('is limited to managers and auditors and validates the period', async () => {
    expect((await call('get', '/api/dashboard', T1)).status).toBe(403);
    expect((await call('get', '/api/dashboard', MGR)).status).toBe(200);
    expect((await call('get', '/api/dashboard', AUD)).status).toBe(200);
    expect((await call('get', '/api/dashboard?days=0', MGR)).status).toBe(400);
    expect((await call('get', '/api/dashboard?days=400', MGR)).status).toBe(400);
  });
});