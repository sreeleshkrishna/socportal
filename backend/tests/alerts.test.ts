import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalize, wazuhLevelToSeverity } from '../src/alerts/normalizers.js';
import { buildTestApp, WEBHOOK_SECRET } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const wazuh = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  rule: { id: '5712', level: 10, description: 'sshd: brute force', mitre: { id: ['T1110'] } },
  agent: { id: '001', name: 'ubuntu-lab', ip: '10.0.0.5' },
  data: { srcip: '192.0.2.10' },
  full_log: 'Failed password for invalid user admin',
  ...over,
});
const send = (payload: object, source = 'wazuh', token = WEBHOOK_SECRET) =>
  request(app).post(`/webhooks/alerts/${source}`).set('X-Webhook-Token', token).send(payload);
const allCases = async () => (await pool.query('select * from cases order by case_number')).rows;

beforeEach(async () => { await pool.query('truncate users, cases restart identity cascade'); });
afterAll(() => pool.end());

describe('normalizers', () => {
  it('maps Wazuh levels to severities', () => {
    expect([3, 8, 10, 13].map(wazuhLevelToSeverity)).toEqual(['low', 'medium', 'high', 'critical']);
  });
  it('rejects malformed payloads', () => {
    expect(() => normalize('wazuh', { nothing: true })).toThrow();
    expect(() => normalize('generic', { rule_id: 'x', rule_name: 'y', severity: 'huge' })).toThrow();
  });
});

describe('webhook security', () => {
  it('rejects a missing or wrong token', async () => {
    expect((await request(app).post('/webhooks/alerts/wazuh').send(wazuh())).status).toBe(401);
    expect((await send(wazuh(), 'wazuh', 'wrong-token')).status).toBe(401);
    expect(await allCases()).toHaveLength(0);
  });
  it('rejects unknown sources and bad payloads', async () => {
    expect((await send(wazuh(), 'splunk')).status).toBe(404);
    expect((await send({ foo: 'bar' })).status).toBe(400);
  });
});

describe('alert -> case', () => {
  it('creates a case from a Wazuh alert quickly', async () => {
    const res = await send(wazuh());
    expect(res.status).toBe(201);
    expect(res.body.result).toBe('created');
    expect(res.body.processingMs).toBeLessThan(3000);
    const [c] = await allCases();
    expect(c).toMatchObject({ status: 'new', severity: 'high', source: 'wazuh', alert_count: 1 });
    expect(c.title).toContain('ubuntu-lab');
  });

  it('ignores a duplicate alert id', async () => {
    const payload = wazuh();
    const first = await send(payload);
    const second = await send(payload);
    expect(second.body.result).toBe('duplicate');
    expect(second.body.caseId).toBe(first.body.caseId);
    expect((await allCases())[0].alert_count).toBe(1);
  });

  it('merges a similar alert and raises severity', async () => {
    await send(wazuh({ rule: { id: '5712', level: 8, description: 'sshd: brute force' } }));
    const res = await send(wazuh({ rule: { id: '5712', level: 13, description: 'sshd: brute force' } }));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('merged');
    const cases = await allCases();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ alert_count: 2, severity: 'critical' });
  });

  it('creates a separate case for a different host', async () => {
    await send(wazuh());
    await send(wazuh({ agent: { id: '002', name: 'other-host' } }));
    expect(await allCases()).toHaveLength(2);
  });

  it('opens a new case when the previous one is resolved', async () => {
    const first = await send(wazuh());
    await pool.query(`update cases set status = 'resolved' where id = $1`, [first.body.caseId]);
    const second = await send(wazuh());
    expect(second.body.result).toBe('created');
    expect(await allCases()).toHaveLength(2);
  });

  it('does not create duplicate cases under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => send(wazuh())));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const cases = await allCases();
    expect(cases).toHaveLength(1);
    expect(cases[0].alert_count).toBe(10);
  });

  it('accepts Elastic and generic alerts', async () => {
    const e = await send({ alert_id: 'e1', rule: { name: 'Odd PowerShell', severity: 'high' }, host: { name: 'win1' } }, 'elastic');
    const g = await send({ id: 'g1', rule_id: 'R1', rule_name: 'Impossible travel', severity: 'medium' }, 'generic');
    expect([e.status, g.status]).toEqual([201, 201]);
  });
});