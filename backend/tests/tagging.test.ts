import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { verifyChain } from '../src/audit/service.js';
import { tryClassifyIoc } from '../src/tagging/ioc.js';
import { bearer, buildTestApp, resetAuditLog, USERS, WEBHOOK_SECRET } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool);

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;

const call = async (method: 'get' | 'post' | 'patch' | 'delete', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const newCase = async () => (await call('post', '/api/cases', T1, { title: 'Tagging case', severity: 'high' })).body;
const iocs = async (caseId: string) => (await call('get', `/api/cases/${caseId}/iocs`, AUD)).body.iocs;
const techs = async (caseId: string) => (await call('get', `/api/cases/${caseId}/techniques`, AUD)).body.techniques;
const auditActions = async () => (await pool.query('select action, detail from audit_log order by seq')).rows;

beforeEach(async () => {
  await flushAudit();
  await resetAuditLog(pool);
  await pool.query('truncate users, cases restart identity cascade');
  await pool.query('delete from iocs');
});
afterAll(async () => { await flushAudit(); await pool.end(); });

describe('indicator classification', () => {
  const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  it.each([
    ['192.168.0.5', 'ip', '192.168.0.5'],
    ['2001:DB8::1', 'ip', '2001:db8::1'],
    ['Evil.Example.COM', 'domain', 'evil.example.com'],
    ['evil[.]example[.]com', 'domain', 'evil.example.com'],
    ['hxxps://evil[.]example[.]com/a?b=1', 'url', 'https://evil.example.com/a?b=1'],
    ['http://Example.com', 'url', 'http://example.com/'],
    ['Alice@Example.COM', 'email', 'alice@example.com'],
    ['alice[@]example[.]com', 'email', 'alice@example.com'],
    ['D41D8CD98F00B204E9800998ECF8427E', 'md5', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['da39a3ee5e6b4b0d3255bfef95601890afd80709', 'sha1', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    [sha256.toUpperCase(), 'sha256', sha256],
  ])('accepts and normalises %s', (input, type, value) => {
    expect(tryClassifyIoc(input)).toEqual({ type, value });
  });

  it.each([
    '', 'not an indicator', 'localhost', '999.1.1.1', 'http://', 'ftp://', 'javascript:alert(1)',
    'a@b', 'evil.com\u0000', 'x'.repeat(2001),
  ])('rejects %j', (input) => {
    expect(tryClassifyIoc(input)).toBeNull();
  });
});

describe('case indicators', () => {
  it('adds a defanged indicator in normalised form and records it', async () => {
    const c = await newCase();
    const res = await call('post', `/api/cases/${c.id}/iocs`, T1, { value: 'Evil[.]Example[.]com', note: 'C2 domain' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'domain', value: 'evil.example.com' });
    const list = await iocs(c.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'manual', note: 'C2 domain', other_cases: 0 });
    const detail = (await call('get', `/api/cases/${c.id}`, T1)).body;
    expect(detail.events.map((e: { type: string }) => e.type)).toContain('ioc_added');
  });

  it('rejects duplicates, invalid values and a wrong declared type', async () => {
    const c = await newCase();
    await call('post', `/api/cases/${c.id}/iocs`, T1, { value: '203.0.113.7' });
    expect((await call('post', `/api/cases/${c.id}/iocs`, T1, { value: '203.0.113.7' })).status).toBe(409);
    const bad = await call('post', `/api/cases/${c.id}/iocs`, T1, { value: 'not an indicator' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_ioc');
    const mismatch = await call('post', `/api/cases/${c.id}/iocs`, T1, { value: '203.0.113.8', type: 'domain' });
    expect(mismatch.body.error).toBe('ioc_type_mismatch');
  });

  it('shows how many other cases share an indicator', async () => {
    const a = await newCase();
    const b = await newCase();
    await call('post', `/api/cases/${a.id}/iocs`, T1, { value: '198.51.100.23' });
    await call('post', `/api/cases/${b.id}/iocs`, T1, { value: '198.51.100.23' });
    expect((await iocs(a.id))[0].other_cases).toBe(1);
  });

  it('auditors can read but not change tags, and closed cases are frozen', async () => {
    const c = await newCase();
    expect((await call('post', `/api/cases/${c.id}/iocs`, AUD, { value: '203.0.113.9' })).status).toBe(403);
    expect((await call('get', `/api/cases/${c.id}/iocs`, AUD)).status).toBe(200);
    await pool.query(`update cases set status = 'closed', closed_at = now() where id = $1`, [c.id]);
    expect((await call('post', `/api/cases/${c.id}/iocs`, T1, { value: '203.0.113.9' })).status).toBe(409);
  });

  it('removing an indicator keeps a record of what was removed', async () => {
    const c = await newCase();
    const added = (await call('post', `/api/cases/${c.id}/iocs`, T1, { value: 'evil.example.com' })).body;
    expect((await call('delete', `/api/cases/${c.id}/iocs/${added.id}`, T1)).status).toBe(200);
    expect(await iocs(c.id)).toHaveLength(0);
    expect((await call('delete', `/api/cases/${c.id}/iocs/${added.id}`, T1)).status).toBe(404);
    const log = await auditActions();
    expect(log.find((r) => r.action === 'ioc.added')!.detail.value).toBe('evil.example.com');
    expect(log.find((r) => r.action === 'ioc.removed')!.detail.value).toBe('evil.example.com');
    expect((await verifyChain(pool)).valid).toBe(true);
  });
});

describe('searching by indicator', () => {
  it('finds cases by exact IP, domain family and substring', async () => {
    const a = await newCase();
    const b = await newCase();
    await call('post', `/api/cases/${a.id}/iocs`, T1, { value: '198.51.100.23' });
    await call('post', `/api/cases/${b.id}/iocs`, T1, { value: '198.51.100.23' });
    await call('post', `/api/cases/${a.id}/iocs`, T1, { value: 'login.evil.example.com' });
    const search = async (q: string) => (await call('get', `/api/search/iocs?q=${encodeURIComponent(q)}`, AUD)).body.results;

    const byIp = await search('198.51.100.23');
    expect(byIp).toHaveLength(1);
    expect(byIp[0].cases).toHaveLength(2);
    expect(await search('198.51.100.2')).toHaveLength(0);          // an IP matches exactly, not by prefix
    expect((await search('evil[.]example[.]com'))[0].value).toBe('login.evil.example.com'); // subdomain
    expect(await search('example.org')).toHaveLength(0);
    expect(await search('evil')).toHaveLength(1);                  // substring
    expect((await call('get', '/api/search/iocs?q=ab', AUD)).status).toBe(400);
  });
});

describe('ATT&CK techniques', () => {
  it('adds, lists, rejects and removes techniques', async () => {
    const c = await newCase();
    const ok = await call('post', `/api/cases/${c.id}/techniques`, T1, { id: 't1110.001' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ id: 'T1110.001', name: 'Password Guessing', tactics: ['Credential Access'] });
    expect((await call('post', `/api/cases/${c.id}/techniques`, T1, { id: 'T1110.001' })).status).toBe(409);
    expect((await call('post', `/api/cases/${c.id}/techniques`, T1, { id: 'T9999' })).body.error).toBe('unknown_technique');
    expect((await call('post', `/api/cases/${c.id}/techniques`, T1, { id: 'brute' })).status).toBe(400);
    expect(await techs(c.id)).toHaveLength(1);

    expect((await call('delete', `/api/cases/${c.id}/techniques/T1110.001`, T1)).status).toBe(200);
    expect((await call('delete', `/api/cases/${c.id}/techniques/T1110.001`, T1)).status).toBe(404);
    const actions = (await auditActions()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['technique.added', 'technique.removed']));
  });

   it('searches the catalog by name and id', async () => {
    const byName = (await call('get', '/api/attack/techniques?q=brute', T1)).body.techniques;
    expect(byName.map((t: { id: string }) => t.id)).toContain('T1110');

    const byWord = (await call('get', '/api/attack/techniques?q=password', T1)).body.techniques;
    expect(byWord.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(['T1110.001', 'T1110.002', 'T1110.003']),
    );

    const byId = (await call('get', '/api/attack/techniques?q=T1566', T1)).body.techniques;
    expect(byId.length).toBeGreaterThanOrEqual(3);
    expect((await call('get', '/api/attack/techniques', T1)).body.techniques.length).toBe(25);
  });
});

describe('automatic tagging from SIEM alerts', () => {
  it('tags the source IP and the rule ATT&CK ids, skipping unknown ids', async () => {
    const res = await request(app).post('/webhooks/alerts/wazuh').set('X-Webhook-Token', WEBHOOK_SECRET).send({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      rule: { id: '5712', level: 10, description: 'sshd: brute force', mitre: { id: ['T1110', 'T9999'] } },
      agent: { id: '001', name: 'lab-host' },
      data: { srcip: '203.0.113.9' },
    });
    expect(res.status).toBe(201);
    const ipTags = await iocs(res.body.caseId);
    expect(ipTags).toHaveLength(1);
    expect(ipTags[0]).toMatchObject({ type: 'ip', value: '203.0.113.9', source: 'siem' });
    const tt = await techs(res.body.caseId);
    expect(tt.map((x: { id: string }) => x.id)).toEqual(['T1110']);
    expect(tt[0].source).toBe('siem');
  });
});