import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deliverPending, type Senders } from '../src/notify/deliver.js';
import { runSlaTick } from '../src/sla/tick.js';
import { bearer, buildTestApp, USERS } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const MGR = { roles: ['soc_manager'], sub: USERS.mgr };
type Who = typeof T1;

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const newCase = async (severity = 'high', title = 'SLA test case') =>
  (await call('post', '/api/cases', T1, { title, severity })).body;
const move = (id: string, to: string, extra: object = {}) => call('post', `/api/cases/${id}/transition`, MGR, { to, ...extra });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const events = (id: string, type: string) => q('select * from case_events where case_id = $1 and type = $2 order by id', [id, type]);
const statusOf = async (id: string) => (await q('select status from cases where id = $1', [id]))[0].status;
const backdate = (id: string, cols: string[]) =>
  pool.query(`update case_sla set ${cols.map((c) => `${c} = now() - interval '1 second'`).join(', ')} where case_id = $1`, [id]);

beforeEach(async () => {
  await pool.query('truncate users, cases restart identity cascade');
  await call('get', '/api/me', MGR); // registers the manager so notifications have a recipient
});
afterAll(() => pool.end());

describe('SLA timers', () => {
  it('starts timers from the severity policy', async () => {
    const c = await newCase('critical');
    const [r] = await q(
      `select extract(epoch from (s.respond_due - c.created_at))::int as respond,
              extract(epoch from (s.resolve_due - c.created_at))::int as resolve,
              extract(epoch from (s.respond_warn_at - c.created_at))::int as warn
       from case_sla s join cases c on c.id = s.case_id where c.id = $1`, [c.id]);
    expect(r).toMatchObject({ respond: 900, resolve: 14400, warn: 720 });
  });

  it('recalculates deadlines when severity changes', async () => {
    const c = await newCase('low');
    await call('patch', `/api/cases/${c.id}`, T1, { severity: 'critical' });
    const [r] = await q(
      `select extract(epoch from (s.respond_due - c.created_at))::int as respond
       from case_sla s join cases c on c.id = s.case_id where c.id = $1`, [c.id]);
    expect(r.respond).toBe(900);
  });

  it('exposes SLA state in the case detail and list', async () => {
    const c = await newCase('high');
    const detail = (await call('get', `/api/cases/${c.id}`, T1)).body;
    expect(detail.sla.overall).toBe('ok');
    const list = (await call('get', '/api/cases', T1)).body;
    expect(list.cases[0].sla.respond.state).toBe('ok');
  });
});

describe('warnings and breaches', () => {
  it('warns once before the deadline', async () => {
    const c = await newCase('high');
    await backdate(c.id, ['respond_warn_at']);
    expect(await runSlaTick(pool)).toBe(1);
    expect(await events(c.id, 'sla_warning')).toHaveLength(1);
    const mails = await q(`select * from notifications where case_id = $1 and kind = 'respond_warning' and channel = 'email'`, [c.id]);
    expect(mails).toHaveLength(1);
    expect(await runSlaTick(pool)).toBe(0); // nothing is sent twice
    expect(await events(c.id, 'sla_warning')).toHaveLength(1);
  });

  it('escalates a new case automatically when the respond target is missed', async () => {
    const c = await newCase('high');
    await backdate(c.id, ['respond_warn_at', 'respond_due']);
    expect(await runSlaTick(pool)).toBe(1);
    expect(await statusOf(c.id)).toBe('escalated');
    const changes = await events(c.id, 'status_changed');
    expect(changes.some((e) => e.detail.auto === true && e.detail.to === 'escalated')).toBe(true);
    expect(await events(c.id, 'sla_breached')).toHaveLength(1);
    expect(await runSlaTick(pool)).toBe(0);
    expect(await events(c.id, 'sla_breached')).toHaveLength(1);
  });

  it('does not breach the respond target once someone has triaged the case', async () => {
    const c = await newCase('high');
    await move(c.id, 'triage');
    await backdate(c.id, ['respond_warn_at', 'respond_due']);
    expect(await runSlaTick(pool)).toBe(0);
    expect(await statusOf(c.id)).toBe('triage');
  });

  it('escalates an in-progress case when the resolve target is missed', async () => {
    const c = await newCase('high');
    await move(c.id, 'triage');
    await move(c.id, 'in_progress');
    await backdate(c.id, ['resolve_warn_at', 'resolve_due']);
    expect(await runSlaTick(pool)).toBe(1);
    expect(await statusOf(c.id)).toBe('escalated');
    expect((await events(c.id, 'sla_breached'))[0].detail.target).toBe('resolve');
  });

  it('records a breach on a contained case without changing its status', async () => {
    const c = await newCase('high');
    for (const to of ['triage', 'in_progress', 'contained']) await move(c.id, to);
    await backdate(c.id, ['resolve_warn_at', 'resolve_due']);
    await runSlaTick(pool);
    expect(await statusOf(c.id)).toBe('contained');
    expect(await events(c.id, 'sla_breached')).toHaveLength(1);
    expect((await events(c.id, 'status_changed')).some((e) => e.detail.auto)).toBe(false);
  });

  it('ignores closed cases', async () => {
    const c = await newCase('high');
    await pool.query(`update cases set status = 'closed', closed_at = now() where id = $1`, [c.id]);
    await backdate(c.id, ['respond_warn_at', 'respond_due', 'resolve_warn_at', 'resolve_due']);
    expect(await runSlaTick(pool)).toBe(0);
  });

  it('two workers at once escalate a case only once', async () => {
    const c = await newCase('high');
    await backdate(c.id, ['respond_warn_at', 'respond_due']);
    const [a, b] = await Promise.all([runSlaTick(pool), runSlaTick(pool)]);
    expect(a + b).toBe(1);
    expect(await events(c.id, 'sla_breached')).toHaveLength(1);
  });
});

describe('notifications', () => {
  it('notifies the SOC manager and strips control characters from the subject', async () => {
    const c = await newCase('high', 'Odd title\nBcc: attacker@evil.test');
    await backdate(c.id, ['respond_warn_at', 'respond_due']);
    await runSlaTick(pool);
    const mails = await q(`select recipient, subject from notifications where case_id = $1 and kind = 'respond_breach' and channel = 'email'`, [c.id]);
    expect(mails).toHaveLength(1);
    expect(mails[0].recipient).toBe('user-4444@test.local');
    expect(mails[0].subject).toContain('Case #');
    expect(mails[0].subject).not.toMatch(/[\r\n]/);
  });

  it('delivers notifications and retries failures, then gives up', async () => {
    const c = await newCase();
    await pool.query(
      `insert into notifications (case_id, kind, channel, recipient, subject, body)
       values ($1, 't', 'email', 'ok@test.local', 's', 'b'), ($1, 't', 'email', 'bad@test.local', 's', 'b')`, [c.id]);
    const sent: string[] = [];
    const senders: Senders = {
      email: async (to) => { if (to.startsWith('bad')) throw new Error('smtp down'); sent.push(to); },
      slack: async () => {},
    };
    expect(await deliverPending(pool, senders)).toBe(1);
    for (let i = 0; i < 4; i++) await deliverPending(pool, senders);
    const rows = await q('select recipient, status, attempts from notifications order by recipient');
    expect(rows).toEqual([
      { recipient: 'bad@test.local', status: 'failed', attempts: 5 },
      { recipient: 'ok@test.local', status: 'sent', attempts: 1 },
    ]);
    expect(sent).toEqual(['ok@test.local']);
  });
});