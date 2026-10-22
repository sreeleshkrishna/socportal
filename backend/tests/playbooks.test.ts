import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { matchPlaybook } from '../src/alerts/playbookMatch.js';
import { bearer, buildTestApp, USERS, WEBHOOK_SECRET } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const T2  = { roles: ['tier2_analyst'], sub: USERS.t2 };
const MGR = { roles: ['soc_manager'], sub: USERS.mgr };
type Who = typeof T1;

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const create = (body: object) => call('post', '/api/cases', T1, body);
const move = (id: string, to: string, extra: object = {}) => call('post', `/api/cases/${id}/transition`, MGR, { to, ...extra });
const detail = async (id: string) => (await call('get', `/api/cases/${id}`, MGR)).body;
const count = async (table: string) => (await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

const wazuh = (description: string) => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  rule: { id: '5712', level: 10, description },
  agent: { id: '001', name: 'lab-host' },
  data: { srcip: '192.0.2.10' },
});
const sendAlert = (payload: object) =>
  request(app).post('/webhooks/alerts/wazuh').set('X-Webhook-Token', WEBHOOK_SECRET).send(payload);

beforeEach(async () => {
  await pool.query('truncate users, cases restart identity cascade');
  await call('get', '/api/me', MGR);
});
afterAll(() => pool.end());

describe('playbooks', () => {
  it('a phishing playbook generates a task checklist', async () => {
    const res = await create({ title: 'Phishing report', severity: 'medium', playbook: 'phishing' });
    expect(res.status).toBe(201);
    const d = await detail(res.body.id);
    expect(d.playbook).toMatchObject({ key: 'phishing' });
    expect(d.tasks.length).toBeGreaterThanOrEqual(6);
    expect(d.tasks.map((t: { position: number }) => t.position)).toEqual(d.tasks.map((_: unknown, i: number) => i + 1));
    expect(d.tasks.every((t: { status: string }) => t.status === 'todo')).toBe(true);
    expect(d.events.map((e: { type: string }) => e.type)).toContain('playbook_applied');
  });

  it('rejects an unknown playbook and creates no case', async () => {
    expect((await create({ title: 'No such playbook', severity: 'low', playbook: 'nope' })).status).toBe(404);
    expect(await count('cases')).toBe(0);
  });

  it('applies a playbook later, only once', async () => {
    const c = (await create({ title: 'Malware on laptop', severity: 'high' })).body;
    const first = await call('post', `/api/cases/${c.id}/playbook`, T1, { key: 'malware' });
    expect(first.status).toBe(200);
    expect(first.body.tasks).toBeGreaterThan(0);
    expect((await call('post', `/api/cases/${c.id}/playbook`, T1, { key: 'phishing' })).status).toBe(409);
  });

  it('lists the available playbooks', async () => {
    const res = await call('get', '/api/playbooks', T1);
    expect(res.body.playbooks.map((p: { key: string }) => p.key).sort())
      .toEqual(['brute-force', 'data-exfiltration', 'malware', 'phishing']);
  });
});

describe('tasks', () => {
  it('the checklist must be finished before a case can be resolved', async () => {
    const c = (await create({ title: 'Phishing with checklist', severity: 'medium', playbook: 'phishing' })).body;
    for (const to of ['triage', 'in_progress', 'contained']) await move(c.id, to);

    const blocked = await move(c.id, 'resolved', { summary: 'Cleaned up' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('open_tasks');

    const tasks = (await detail(c.id)).tasks as { id: string }[];
    for (const t of tasks.slice(0, -1)) {
      expect((await call('patch', `/api/cases/${c.id}/tasks/${t.id}`, T1, { status: 'done' })).status).toBe(200);
    }
    expect((await move(c.id, 'resolved', { summary: 'Cleaned up' })).status).toBe(409); // one task left
    await call('patch', `/api/cases/${c.id}/tasks/${tasks[tasks.length - 1].id}`, T1, { status: 'skipped' });
    expect((await move(c.id, 'resolved', { summary: 'Cleaned up' })).status).toBe(200); // skipped counts as finished
  });

  it('only users who may assign cases can assign tasks', async () => {
    const c = (await create({ title: 'Task assignment', severity: 'low', playbook: 'brute-force' })).body;
    const [t] = (await detail(c.id)).tasks as { id: string }[];
    const url = `/api/cases/${c.id}/tasks/${t.id}`;
    expect((await call('patch', url, T1, { assigneeId: USERS.mgr })).status).toBe(403);
    const ok = await call('patch', url, T2, { assigneeId: USERS.mgr });
    expect(ok.status).toBe(200);
    expect(ok.body.assignee_id).toBe(USERS.mgr);
    expect((await call('patch', url, T2, { assigneeId: '66666666-6666-4666-8666-666666666666' })).status).toBe(400);
  });

  it('supports ad-hoc tasks and blocks changes on closed cases', async () => {
    const c = (await create({ title: 'Ad hoc tasks', severity: 'low' })).body;
    const added = await call('post', `/api/cases/${c.id}/tasks`, T1, { title: 'Call the user' });
    expect(added.status).toBe(201);
    expect(added.body.position).toBe(1);
    await pool.query(`update cases set status = 'closed', closed_at = now() where id = $1`, [c.id]);
    const res = await call('patch', `/api/cases/${c.id}/tasks/${added.body.id}`, T1, { status: 'done' });
    expect(res.status).toBe(409);
  });
});

describe('playbooks from SIEM alerts', () => {
  it('a brute-force alert gets the brute-force checklist and SLA timers', async () => {
    const res = await sendAlert(wazuh('sshd: brute force trying to get access to the system.'));
    expect(res.status).toBe(201);
    const [row] = (await pool.query(
      `select p.key, (select count(*)::int from case_tasks t where t.case_id = c.id) as tasks,
              (select count(*)::int from case_sla s where s.case_id = c.id) as sla
       from cases c left join playbooks p on p.id = c.playbook_id where c.id = $1`, [res.body.caseId])).rows;
    expect(row).toMatchObject({ key: 'brute-force', sla: 1 });
    expect(row.tasks).toBeGreaterThanOrEqual(5);
  });

  it('an alert with no matching rule gets no playbook', async () => {
    const res = await sendAlert(wazuh('Disk space is almost full'));
    const [row] = (await pool.query('select playbook_id from cases where id = $1', [res.body.caseId])).rows;
    expect(row.playbook_id).toBeNull();
  });
});

describe('playbook matching', () => {
  it('chooses by rule name', () => {
    expect(matchPlaybook({ ruleName: 'sshd: brute force trying to get access to the system.' })).toBe('brute-force');
    expect(matchPlaybook({ ruleName: 'Phishing email reported' })).toBe('phishing');
    expect(matchPlaybook({ ruleName: 'Ransomware behaviour detected' })).toBe('malware');
    expect(matchPlaybook({ ruleName: 'Large outbound data transfer' })).toBe('data-exfiltration');
    expect(matchPlaybook({ ruleName: 'Disk space low' })).toBeNull();
  });
});