import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAudit } from '../src/audit/middleware.js';
import { verifyChain } from '../src/audit/service.js';
import { safeFilename } from '../src/evidence/service.js';
import { bearer, buildTestApp, memoryStore, resetAuditLog, USERS } from './helpers.js';
import { makePool } from './testDb.js';

const pool = makePool();
const store = memoryStore();
const app = buildTestApp(pool, { store });
const smallApp = buildTestApp(pool, { store: memoryStore(), maxUploadBytes: 1024 });

const T1  = { roles: ['tier1_analyst'], sub: USERS.t1 };
const AUD = { roles: ['auditor'], sub: USERS.aud };
type Who = typeof T1;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await flushAudit(); };

const call = async (method: 'get' | 'post' | 'patch', path: string, who: Who, body?: object) => {
  const req = request(app)[method](path).set('Authorization', await bearer(who.roles, who.sub));
  return body ? req.send(body) : req;
};
const newCase = async () => (await call('post', '/api/cases', T1, { title: 'Evidence case', severity: 'high' })).body;

const upload = async (caseId: string, who: Who, content: Buffer | string, filename = 'sample.txt', target = app) =>
  request(target)
    .post(`/api/cases/${caseId}/evidence`)
    .set('Authorization', await bearer(who.roles, who.sub))
    .attach('file', Buffer.from(content), { filename, contentType: 'text/plain' });

const binary = (res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const vUrl = (caseId: string, evidenceId: string, version: number, what: 'download' | 'verify') =>
  `/api/cases/${caseId}/evidence/${evidenceId}/versions/${version}/${what}`;
const custodyActions = async (caseId: string, evidenceId: string) =>
  (await call('get', `/api/cases/${caseId}/evidence/${evidenceId}/custody`, AUD)).body.custody.map((c: { action: string }) => c.action);

beforeEach(async () => {
  await flushAudit();
  await resetAuditLog(pool);
  await pool.query('truncate users, cases restart identity cascade');
  store.objects.clear();
});
afterAll(async () => { await flushAudit(); await pool.end(); });

describe('upload', () => {
  it('stores the file encrypted and records its SHA-256', async () => {
    const c = await newCase();
    const body = `TOP-SECRET-MARKER ${'x'.repeat(200)}`;
    const res = await upload(c.id, T1, body, 'malware-sample.txt');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'malware-sample.txt', version: 1, size: Buffer.byteLength(body), sha256: sha(body) });
    expect(store.objects.size).toBe(1);
    const [stored] = [...store.objects.values()];
    expect(stored.includes(Buffer.from('TOP-SECRET-MARKER'))).toBe(false);
    expect(stored.equals(Buffer.from(body))).toBe(false);
  });

  it('a second upload with the same name becomes version 2', async () => {
    const c = await newCase();
    await upload(c.id, T1, 'first', 'log.txt');
    const second = await upload(c.id, T1, 'second', 'log.txt');
    await upload(c.id, T1, 'other file', 'other.txt');
    expect(second.body.version).toBe(2);
    const list = (await call('get', `/api/cases/${c.id}/evidence`, AUD)).body.evidence;
    expect(list).toHaveLength(2);
    expect(list.find((i: { name: string }) => i.name === 'log.txt').versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it('cleans hostile filenames', async () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFilename('<script>alert(1)</script>.html')).toMatch(/^[\w.\- ()]+$/);
    expect(safeFilename('...')).toBe('file');
    const c = await newCase();
    const res = await upload(c.id, T1, 'x', 'we"ird<name>.txt');
    expect(res.body.name).toMatch(/^[\w.\- ()%]+$/);
  });

  it('rejects missing files, oversized files, closed cases and auditors', async () => {
    const c = await newCase();
    expect((await call('post', `/api/cases/${c.id}/evidence`, T1, {})).status).toBe(400);

    const big = await upload(c.id, T1, Buffer.alloc(5000, 1), 'big.bin', smallApp);
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('file_too_large');

    expect((await upload(c.id, AUD, 'x')).status).toBe(403);

    await pool.query(`update cases set status = 'closed', closed_at = now() where id = $1`, [c.id]);
    expect((await upload(c.id, T1, 'x')).status).toBe(409);
  });
});

describe('download, verify and custody', () => {
  it('returns the exact bytes and records custody', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'evidence body', 'log.txt')).body;
    const dl = await request(app).get(vUrl(c.id, up.evidenceId, 1, 'download'))
      .set('Authorization', await bearer(AUD.roles, AUD.sub)).buffer(true).parse(binary as never);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-evidence-sha256']).toBe(sha('evidence body'));
    expect((dl.body as Buffer).equals(Buffer.from('evidence body'))).toBe(true);
    expect(await custodyActions(c.id, up.evidenceId)).toEqual(['uploaded', 'downloaded']);
  });

  it('verifies an untouched file', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'clean evidence', 'a.txt')).body;
    const v = await call('post', vUrl(c.id, up.evidenceId, 1, 'verify'), AUD);
    expect(v.body).toMatchObject({ valid: true, expectedSha256: sha('clean evidence'), actualSha256: sha('clean evidence') });
    expect(await custodyActions(c.id, up.evidenceId)).toEqual(['uploaded', 'verified']);
  });

  it('detects a modified object, blocks the download and logs the failure', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'original evidence', 'disk.img')).body;
    const [key] = [...store.objects.keys()];
    const stored = Buffer.from(store.objects.get(key)!);
    stored[0] ^= 0xff;
    store.objects.set(key, stored);

    const v = await call('post', vUrl(c.id, up.evidenceId, 1, 'verify'), AUD);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ valid: false, reason: 'decrypt_failed' });
    const dl = await call('get', vUrl(c.id, up.evidenceId, 1, 'download'), T1);
    expect(dl.status).toBe(409);
    expect(dl.body.error).toBe('integrity_check_failed');
    expect(await custodyActions(c.id, up.evidenceId)).toEqual(['uploaded', 'verify_failed', 'verify_failed']);
  });

  it('detects a recorded hash that no longer matches the content', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'some evidence', 'a.txt')).body;
    await pool.query('alter table evidence_versions disable trigger user');
    try {
      await pool.query('update evidence_versions set sha256 = $1', [sha('something else')]);
    } finally {
      await pool.query('alter table evidence_versions enable trigger user');
    }
    const v = await call('post', vUrl(c.id, up.evidenceId, 1, 'verify'), AUD);
    expect(v.body).toMatchObject({ valid: false, reason: 'hash_mismatch' });
  });

  it('detects a missing object', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'will vanish', 'a.txt')).body;
    store.objects.clear();
    const v = await call('post', vUrl(c.id, up.evidenceId, 1, 'verify'), AUD);
    expect(v.body).toMatchObject({ valid: false, reason: 'object_missing' });
  });

  it('detects ciphertext swapped between versions', async () => {
    const c = await newCase();
    await upload(c.id, T1, 'version one', 'a.txt');
    const second = (await upload(c.id, T1, 'version two', 'a.txt')).body;
    const [k1, k2] = [...store.objects.keys()];
    store.objects.set(k2, store.objects.get(k1)!);
    const v = await call('post', vUrl(c.id, second.evidenceId, 2, 'verify'), AUD);
    expect(v.body).toMatchObject({ valid: false, reason: 'decrypt_failed' });
  });

  it('does not expose evidence through another case', async () => {
    const a = await newCase();
    const b = await newCase();
    const up = (await upload(a.id, T1, 'case A only', 'a.txt')).body;
    expect((await call('get', vUrl(b.id, up.evidenceId, 1, 'download'), T1)).status).toBe(404);
    expect((await call('get', `/api/cases/${b.id}/evidence/${up.evidenceId}/custody`, T1)).status).toBe(404);
  });
});

describe('immutability and audit', () => {
  it('the database refuses changes to versions and custody records', async () => {
    const c = await newCase();
    await upload(c.id, T1, 'fixed evidence', 'a.txt');
    await expect(pool.query('update evidence_versions set sha256 = $1', ['0'.repeat(64)])).rejects.toThrow(/immutable/);
    await expect(pool.query('delete from custody_log')).rejects.toThrow(/immutable/);
  });

  it('every evidence action is in the hash-chained audit log', async () => {
    const c = await newCase();
    const up = (await upload(c.id, T1, 'audited evidence', 'a.txt')).body;
    await call('get', vUrl(c.id, up.evidenceId, 1, 'download'), AUD);
    await call('post', vUrl(c.id, up.evidenceId, 1, 'verify'), AUD);
    await settle();
    const actions = (await pool.query('select action, detail from audit_log order by seq')).rows;
    for (const a of ['evidence.uploaded', 'evidence.downloaded', 'evidence.verified']) {
      expect(actions.some((r) => r.action === a)).toBe(true);
    }
    expect(actions.find((r) => r.action === 'evidence.uploaded')!.detail.sha256).toBe(sha('audited evidence'));
    expect((await verifyChain(pool)).valid).toBe(true);
  });
});