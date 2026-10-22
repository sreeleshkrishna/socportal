import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { verifyChain } from '../src/audit/service.js';
import type { AuthUser } from '../src/auth/authenticate.js';
import { collectReport, renderReport } from '../src/reports/caseReport.js';
import { bearer, buildTestApp, memoryStore, resetAuditLog, USERS } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const app = buildTestApp(pool, { store: memoryStore() });

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;
const auditor: AuthUser = { id: USERS.aud, username: 'user-5555', roles: ['auditor'] };

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const binary = (res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// a case with indicators, a technique, a playbook, a note and an evidence file
async function populatedCase(title = 'Report case') {
  const c = (await call('post', '/api/cases', T1, { title, severity: 'high', playbook: 'phishing' })).body;
  await call('post', `/api/cases/${c.id}/iocs`, T1, { value: 'hxxp://evil[.]example[.]com/login' });
  await call('post', `/api/cases/${c.id}/techniques`, T1, { id: 'T1566.002' });
  await call('post', `/api/cases/${c.id}/notes`, T1, { body: 'Reported by finance' });
  await request(app).post(`/api/cases/${c.id}/evidence`)
    .set('Authorization', await bearer(T1.roles, T1.sub))
    .attach('file', Buffer.from('suspicious attachment'), { filename: 'invoice.txt', contentType: 'text/plain' });
  return c as { id: string; case_number: string };
}

beforeEach(async () => {
  await flushAudit();
  await resetAuditLog(pool);
  await pool.query('truncate users, cases restart identity cascade');
  await pool.query('delete from iocs');
});
afterAll(async () => { await flushAudit(); await pool.end(); });

describe('report content', () => {
  it('collects everything a reviewer needs', async () => {
    const c = await populatedCase();
    const data = await collectReport(pool, auditor, c.id);
    expect(data.generatedBy).toBe('user-5555');
    expect(data.detail.tasks.length).toBeGreaterThanOrEqual(6);
    expect(data.iocs.map((i) => i.value)).toContain('http://evil.example.com/login');
    expect(data.techniques.map((t) => t.id)).toEqual(['T1566.002']);
    expect(data.evidence).toHaveLength(1);
    expect(data.evidence[0].versions[0].sha256).toBe(createHash('sha256').update('suspicious attachment').digest('hex'));
    expect(data.evidence[0].custody.map((x) => x.action)).toEqual(['uploaded']);
    expect(data.audit.valid).toBe(true);
    expect(data.createdBy).toBe('user-1111');
  });

  it('renders a valid PDF even for hostile and non-Latin text', async () => {
    const c = await populatedCase('<b>Ünïcödé 😀 Привет</b> & "quotes"');
    const data = await collectReport(pool, auditor, c.id);
    data.detail.description = `line one\nline two \u0000 ${'long text '.repeat(600)}`;
    const pdf = await renderReport(data);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-16).toString()).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('a long timeline produces a longer document', async () => {
    const c = await populatedCase();
    const data = await collectReport(pdfSafe(pool), auditor, c.id);
    const small = await renderReport(data);
    const big = { ...data, detail: { ...data.detail, events: Array.from({ length: 150 }, (_, i) => ({
      id: i, type: 'note_added', actor: 'user-1111', detail: { i }, created_at: new Date() })) } };
    expect((await renderReport(big)).length).toBeGreaterThan(small.length);
  });
});

const pdfSafe = <T,>(x: T) => x;

describe('report export', () => {
  it('returns a PDF whose hash is recorded in the audit chain', async () => {
    const c = await populatedCase();
    const res = await request(app).get(`/api/cases/${c.id}/report`)
      .set('Authorization', await bearer(AUD.roles, AUD.sub)).buffer(true).parse(binary as never);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`case-${c.case_number}-report.pdf`);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    const sha = createHash('sha256').update(body).digest('hex');
    expect(res.headers['x-report-sha256']).toBe(sha);

    const rows = (await pool.query(`select detail from audit_log where action = 'report.export'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ sha256: sha, bytes: body.length });
    expect((await verifyChain(pool)).valid).toBe(true);
    const events = (await call('get', `/api/cases/${c.id}`, T1)).body.events.map((e: { type: string }) => e.type);
    expect(events).toContain('report_exported');
  });

  it('works for closed cases and returns 404 for unknown ones', async () => {
    const c = await populatedCase();
    await pool.query(`update cases set status = 'closed', closed_at = now() where id = $1`, [c.id]);
    expect((await call('get', `/api/cases/${c.id}/report`, AUD)).status).toBe(200);
    expect((await call('get', '/api/cases/99999999-9999-4999-8999-999999999999/report', AUD)).status).toBe(404);
  });
});