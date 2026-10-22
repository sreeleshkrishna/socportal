import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/service.js';
import type { AuthUser } from '../auth/authenticate.js';
import { addEvent } from '../cases/events.js';
import { assertOpen, lockCase } from '../cases/service.js';
import { withTx } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { decrypt, encrypt, sha256Hex } from './crypto.js';
import type { ObjectStore } from './storage.js';

export interface EvidenceCtx { db: Pool; store: ObjectStore; key: Buffer; ip: string | null }

interface VersionRow {
  id: string; evidence_id: string; version: number; original_filename: string; content_type: string;
  size_bytes: string; sha256: string; object_key: string; enc_iv: string; enc_tag: string; name: string;
}

type Check =
  | { ok: true; plain: Buffer; sha: string }
  | { ok: false; reason: 'object_missing' | 'decrypt_failed' | 'hash_mismatch'; sha: string | null };

type CustodyAction = 'uploaded' | 'downloaded' | 'verified' | 'verify_failed';

// Uploaded names are untrusted: no paths, no markup, no control characters
export function safeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return cleaned || 'file';
}

const safeMime = (m: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(m) ? m.slice(0, 100) : 'application/octet-stream');
const who = (a: AuthUser) => a.username || a.id;

async function writeCustody(
  c: PoolClient, ctx: EvidenceCtx, actor: AuthUser, caseId: string,
  v: { id: string; evidence_id: string; version: number; sha256: string; name: string },
  action: CustodyAction, detail: Record<string, unknown> = {},
) {
  await c.query(
    `insert into custody_log (version_id, case_id, action, actor_id, actor_name, sha256, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [v.id, caseId, action, actor.id, who(actor), v.sha256, JSON.stringify(detail)]);
  await addEvent(c, caseId, actor.id, `evidence_${action}`, { name: v.name, version: v.version, ...detail });
  await appendAudit(c, {
    actorId: actor.id, actorName: who(actor), action: `evidence.${action}`,
    entity: 'evidence', entityId: v.evidence_id, ip: ctx.ip,
    detail: { caseId, name: v.name, version: v.version, sha256: v.sha256, ...detail },
  });
}

const record = (
  ctx: EvidenceCtx, actor: AuthUser, caseId: string, v: VersionRow, action: CustodyAction, detail: Record<string, unknown> = {},
) => withTx(ctx.db, (c) => writeCustody(c, ctx, actor, caseId, v, action, detail));

async function loadVersion(db: Pool, caseId: string, evidenceId: string, version: number): Promise<VersionRow> {
  const r = await db.query(
    `select v.*, e.name from evidence_versions v join evidence e on e.id = v.evidence_id
     where e.case_id = $1 and e.id = $2 and v.version = $3`, [caseId, evidenceId, version]);
  if (!r.rowCount) throw new HttpError(404, 'evidence_not_found', 'Evidence version not found');
  return r.rows[0] as VersionRow;
}

// Reads from storage, decrypts, and compares the SHA-256 with the value recorded at upload
async function readAndCheck(ctx: EvidenceCtx, v: VersionRow): Promise<Check> {
  let stored: Buffer;
  try {
    stored = await ctx.store.get(v.object_key);
  } catch (e) {
    if ((e as Error).name === 'NoSuchKey') return { ok: false, reason: 'object_missing', sha: null };
    console.error('[evidence] storage get failed', e);
    throw new HttpError(502, 'storage_unavailable', 'Evidence storage is unavailable');
  }
  let plain: Buffer;
  try {
    plain = decrypt(ctx.key, stored, v.enc_iv, v.enc_tag, v.object_key);
  } catch {
    return { ok: false, reason: 'decrypt_failed', sha: null };
  }
  const sha = sha256Hex(plain);
  return sha === v.sha256 ? { ok: true, plain, sha } : { ok: false, reason: 'hash_mismatch', sha };
}

export async function uploadEvidence(
  ctx: EvidenceCtx, actor: AuthUser, caseId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  meta: { name?: string; description?: string },
) {
  const filename = safeFilename(file.originalname);
  const name = (meta.name?.trim() || filename).slice(0, 200);
  const sha = sha256Hex(file.buffer);

  return withTx(ctx.db, async (c) => {
    assertOpen(await lockCase(c, caseId));

    await c.query(
      `insert into evidence (case_id, name, description, created_by) values ($1, $2, $3, $4)
       on conflict (case_id, name) do nothing`,
      [caseId, name, meta.description ?? '', actor.id]);
    const item = (await c.query('select id from evidence where case_id = $1 and name = $2 for update', [caseId, name])).rows[0];
    const nextVersion = (await c.query(
      'select coalesce(max(version), 0) + 1 as v from evidence_versions where evidence_id = $1', [item.id])).rows[0].v as number;

    // Store the encrypted object first: if this fails nothing is committed.
    // If the commit fails afterwards, the leftover object is encrypted and unreferenced.
    const objectKey = `${caseId}/${item.id}/v${nextVersion}-${randomUUID()}`;
    const enc = encrypt(ctx.key, file.buffer, objectKey);
    try {
      await ctx.store.put(objectKey, enc.data);
    } catch (e) {
      console.error('[evidence] storage put failed', e);
      throw new HttpError(502, 'storage_unavailable', 'Evidence storage is unavailable');
    }

    const v = (await c.query(
      `insert into evidence_versions
         (evidence_id, version, original_filename, content_type, size_bytes, sha256, object_key, enc_iv, enc_tag, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [item.id, nextVersion, filename, safeMime(file.mimetype), file.buffer.length, sha, objectKey, enc.iv, enc.tag, actor.id])).rows[0];

    await writeCustody(c, ctx, actor, caseId,
      { id: v.id, evidence_id: item.id, version: nextVersion, sha256: sha, name }, 'uploaded', { size: file.buffer.length });

    return { evidenceId: item.id as string, versionId: v.id as string, name, version: nextVersion, sha256: sha, size: file.buffer.length };
  });
}

export async function downloadEvidence(ctx: EvidenceCtx, actor: AuthUser, caseId: string, evidenceId: string, version: number) {
  const v = await loadVersion(ctx.db, caseId, evidenceId, version);
  const res = await readAndCheck(ctx, v);
  if (!res.ok) {
    await record(ctx, actor, caseId, v, 'verify_failed', { reason: res.reason, trigger: 'download' });
    throw new HttpError(409, 'integrity_check_failed', 'Stored evidence no longer matches its recorded hash; download blocked');
  }
  await record(ctx, actor, caseId, v, 'downloaded', { size: res.plain.length });
  return { filename: v.original_filename, plain: res.plain, sha256: v.sha256 };
}

export async function verifyEvidence(ctx: EvidenceCtx, actor: AuthUser, caseId: string, evidenceId: string, version: number) {
  const v = await loadVersion(ctx.db, caseId, evidenceId, version);
  const res = await readAndCheck(ctx, v);
  await record(ctx, actor, caseId, v, res.ok ? 'verified' : 'verify_failed',
    res.ok ? { trigger: 'verify' } : { reason: res.reason, trigger: 'verify' });
  return { valid: res.ok, version: v.version, expectedSha256: v.sha256, actualSha256: res.sha, reason: res.ok ? null : res.reason };
}

export async function listEvidence(db: Pool, caseId: string) {
  const exists = await db.query('select 1 from cases where id = $1', [caseId]);
  if (!exists.rowCount) throw new HttpError(404, 'not_found', 'Case not found');
  const items = await db.query(
    'select id, name, description, created_at from evidence where case_id = $1 order by created_at, name', [caseId]);
  const versions = await db.query(
    `select v.evidence_id, v.version, v.original_filename, v.size_bytes, v.sha256, v.uploaded_at, u.username as uploaded_by
     from evidence_versions v
     join evidence e on e.id = v.evidence_id
     left join users u on u.id = v.uploaded_by
     where e.case_id = $1 order by v.version`, [caseId]);
  return {
    evidence: items.rows.map((i) => ({
      ...i,
      versions: versions.rows.filter((v) => v.evidence_id === i.id).map(({ evidence_id, ...rest }) => rest),
    })),
  };
}

export async function listCustody(db: Pool, caseId: string, evidenceId: string) {
  const item = await db.query('select 1 from evidence where id = $1 and case_id = $2', [evidenceId, caseId]);
  if (!item.rowCount) throw new HttpError(404, 'evidence_not_found', 'Evidence not found');
  const r = await db.query(
    `select c.id, v.version, c.action, c.actor_name, c.sha256, c.detail, c.at
     from custody_log c
     join evidence_versions v on v.id = c.version_id
     where v.evidence_id = $1 order by c.id`, [evidenceId]);
  return { custody: r.rows };
}