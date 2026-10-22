import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db/tx.js';

export const GENESIS = '0'.repeat(64);
const LOCK_KEY = 7340001; // arbitrary constant: serialises appends so the chain cannot fork

export interface AuditEntry {
  actorId?: string | null;
  actorName: string;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export interface HashedFields {
  at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
}

// JSON with sorted keys, so the same record always hashes the same way
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const hashRecord = (prevHash: string, f: HashedFields) =>
  createHash('sha256').update(prevHash).update('\n').update(canonical(f)).digest('hex');

// Makes detail safe for jsonb and keeps entries small
function clean(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.replace(/\u0000/g, '').slice(0, 500);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || typeof v === 'boolean' || v === undefined) return v;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1) ?? null);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const c = clean(x, depth + 1);
      if (c !== undefined) out[k.slice(0, 100)] = c;
    }
    return out;
  }
  return String(v);
}

// Must run inside a transaction: the advisory lock lasts until it ends
export async function appendAudit(c: PoolClient, e: AuditEntry): Promise<{ seq: string; hash: string }> {
  await c.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
  const last = await c.query('select hash from audit_log order by seq desc limit 1');
  const prev: string = last.rows[0]?.hash ?? GENESIS;
  const fields: HashedFields = {
    at: new Date().toISOString(),
    actor_id: e.actorId ?? null,
    actor_name: e.actorName.slice(0, 200),
    action: e.action,
    entity: e.entity ?? null,
    entity_id: e.entityId ?? null,
    ip: e.ip ?? null,
    detail: clean(e.detail ?? {}) as Record<string, unknown>,
  };
  const hash = hashRecord(prev, fields);
  const r = await c.query(
    `insert into audit_log (at, actor_id, actor_name, action, entity, entity_id, ip, detail, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning seq`,
    [fields.at, fields.actor_id, fields.actor_name, fields.action, fields.entity, fields.entity_id,
     fields.ip, JSON.stringify(fields.detail), prev, hash],
  );
  return { seq: String(r.rows[0].seq), hash };
}

export const auditStandalone = (db: Pool, e: AuditEntry) => withTx(db, (c) => appendAudit(c, e));

interface AuditRow {
  seq: string; at: Date | string; actor_id: string | null; actor_name: string; action: string;
  entity: string | null; entity_id: string | null; ip: string | null;
  detail: Record<string, unknown>; prev_hash: string; hash: string;
}

const rowFields = (r: AuditRow): HashedFields => ({
  at: new Date(r.at).toISOString(),
  actor_id: r.actor_id, actor_name: r.actor_name, action: r.action,
  entity: r.entity, entity_id: r.entity_id, ip: r.ip, detail: r.detail,
});

export interface VerifyResult {
  valid: boolean;
  checked: number;
  head: { seq: string; hash: string } | null;
  brokenAtSeq?: string;
  reason?: string;
  anchorFound: boolean | null;
}

// Walks the whole chain in batches. "anchor" is a head hash you saved earlier:
// it proves nothing before that point was removed (the chain alone cannot show a truncated tail).
export async function verifyChain(db: Pool, anchor?: string): Promise<VerifyResult> {
  let lastSeq = '0';
  let prev = GENESIS;
  let checked = 0;
  let anchorFound = false;
  for (;;) {
    const r = await db.query(
      `select seq, at, actor_id, actor_name, action, entity, entity_id, ip, detail, prev_hash, hash
       from audit_log where seq > $1 order by seq limit 1000`, [lastSeq]);
    if (!r.rowCount) break;
    for (const row of r.rows as AuditRow[]) {
      const broken = (reason: string): VerifyResult =>
        ({ valid: false, checked, head: null, brokenAtSeq: String(row.seq), reason, anchorFound: null });
      if (row.prev_hash !== prev) {
        return broken('prev_hash does not match the previous record: a record was removed, inserted or reordered');
      }
      if (hashRecord(prev, rowFields(row)) !== row.hash) {
        return broken('record content does not match its stored hash: the record was modified');
      }
      prev = row.hash;
      lastSeq = String(row.seq);
      checked++;
      if (anchor && row.hash === anchor) anchorFound = true;
    }
  }
  return {
    valid: true, checked,
    head: checked ? { seq: lastSeq, hash: prev } : null,
    anchorFound: anchor ? anchorFound : null,
  };
}

export async function listAudit(
  db: Pool,
  f: { limit: number; before?: number; action?: string; actor?: string; entity?: string; entityId?: string },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.before) add('seq < ?', f.before);
  if (f.action) add('action = ?', f.action);
  if (f.actor) add('actor_name = ?', f.actor);
  if (f.entity) add('entity = ?', f.entity);
  if (f.entityId) add('entity_id = ?', f.entityId);
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const r = await db.query(
    `select seq, at, actor_id, actor_name, action, entity, entity_id, ip, detail, prev_hash, hash
     from audit_log ${clause} order by seq desc limit $${params.length + 1}`,
    [...params, f.limit],
  );
  return { entries: r.rows, nextBefore: r.rowCount === f.limit ? r.rows[r.rows.length - 1].seq : null };
}