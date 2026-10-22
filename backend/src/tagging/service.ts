import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/service.js';
import type { AuthUser } from '../auth/authenticate.js';
import { addEvent } from '../cases/events.js';
import { assertOpen, lockCase } from '../cases/service.js';
import { withTx } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { classifyIoc, refang, tryClassifyIoc, type Ioc, type IocType } from './ioc.js';

type Source = 'manual' | 'siem';
const who = (a: AuthUser) => a.username || a.id;
const esc = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const TECHNIQUE_RE = /^T\d{4}(\.\d{3})?$/;

async function ensureCase(db: Pool, caseId: string) {
  const r = await db.query('select 1 from cases where id = $1', [caseId]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Case not found');
}

/* ---------------- indicators ---------------- */

export async function attachIoc(
  c: PoolClient, caseId: string, ioc: Ioc, source: Source, actorId: string | null, note = '',
): Promise<{ added: boolean; iocId: string }> {
  const r = await c.query(
    `insert into iocs (type, value) values ($1, $2)
     on conflict (type, value) do update set value = excluded.value returning id`,
    [ioc.type, ioc.value]);
  const iocId = r.rows[0].id as string;
  const link = await c.query(
    `insert into case_iocs (case_id, ioc_id, source, note, added_by) values ($1, $2, $3, $4, $5)
     on conflict do nothing`,
    [caseId, iocId, source, note, actorId]);
  return { added: link.rowCount === 1, iocId };
}

export async function listCaseIocs(db: Pool, caseId: string) {
  await ensureCase(db, caseId);
  const r = await db.query(
    `select i.id, i.type, i.value, ci.source, ci.note, ci.added_at, u.username as added_by,
            (select count(*)::int from case_iocs x where x.ioc_id = i.id and x.case_id <> ci.case_id) as other_cases
     from case_iocs ci
     join iocs i on i.id = ci.ioc_id
     left join users u on u.id = ci.added_by
     where ci.case_id = $1 order by ci.added_at, i.value`, [caseId]);
  return { iocs: r.rows };
}

export async function addIoc(
  db: Pool, actor: AuthUser, caseId: string,
  input: { value: string; type?: IocType; note?: string }, ip: string | null,
) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const ioc = classifyIoc(input.value, input.type);
    const { added, iocId } = await attachIoc(c, caseId, ioc, 'manual', actor.id, input.note ?? '');
    if (!added) throw new HttpError(409, 'ioc_already_tagged', 'This indicator is already on the case');
    await addEvent(c, caseId, actor.id, 'ioc_added', ioc);
    await appendAudit(c, {
      actorId: actor.id, actorName: who(actor), action: 'ioc.added',
      entity: 'case', entityId: caseId, ip, detail: { ...ioc, iocId },
    });
    return { id: iocId, ...ioc };
  });
}

export async function removeIoc(db: Pool, actor: AuthUser, caseId: string, iocId: string, ip: string | null) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const cur = await c.query(
      `select i.type, i.value from case_iocs ci join iocs i on i.id = ci.ioc_id
       where ci.case_id = $1 and ci.ioc_id = $2`, [caseId, iocId]);
    if (!cur.rowCount) throw new HttpError(404, 'ioc_not_found', 'That indicator is not on this case');
    await c.query('delete from case_iocs where case_id = $1 and ioc_id = $2', [caseId, iocId]);
    const { type, value } = cur.rows[0];
    await addEvent(c, caseId, actor.id, 'ioc_removed', { type, value });
    await appendAudit(c, {
      actorId: actor.id, actorName: who(actor), action: 'ioc.removed',
      entity: 'case', entityId: caseId, ip, detail: { type, value, iocId },
    });
    return { removed: true };
  });
}

export async function searchIocs(db: Pool, f: { q: string; type?: IocType }) {
  const params: unknown[] = [];
  let where: string;
  const parsed = tryClassifyIoc(f.q);
  if (parsed && ['md5', 'sha1', 'sha256', 'ip', 'email'].includes(parsed.type)) {
    params.push(parsed.type, parsed.value);
    where = 'i.type = $1 and i.value = $2';
  } else if (parsed?.type === 'domain') {
    // the domain itself or any subdomain of it
    params.push(parsed.value, `%.${esc(parsed.value)}`);
    where = `i.type = 'domain' and (i.value = $1 or i.value like $2 escape '\\')`;
  } else {
    params.push(`%${esc(refang(f.q))}%`);
    where = `i.value ilike $1 escape '\\'`;
  }
  if (f.type) {
    params.push(f.type);
    where += ` and i.type = $${params.length}`;
  }
  const r = await db.query(
    `select i.id, i.type, i.value, cs.id as case_id, cs.case_number, cs.title, cs.status, cs.severity
     from iocs i
     join case_iocs ci on ci.ioc_id = i.id
     join cases cs on cs.id = ci.case_id
     where ${where} order by i.value, cs.case_number desc limit 300`, params);

  const map = new Map<string, { id: string; type: string; value: string; cases: unknown[] }>();
  for (const row of r.rows) {
    let e = map.get(row.id);
    if (!e) { e = { id: row.id, type: row.type, value: row.value, cases: [] }; map.set(row.id, e); }
    e.cases.push({ id: row.case_id, case_number: row.case_number, title: row.title, status: row.status, severity: row.severity });
  }
  return { results: [...map.values()] };
}

/* ---------------- ATT&CK techniques ---------------- */

const parseTechnique = (raw: string) => {
  const id = raw.trim().toUpperCase();
  if (!TECHNIQUE_RE.test(id)) throw new HttpError(400, 'invalid_technique', 'Use an ATT&CK ID such as T1110 or T1110.001');
  return id;
};

export async function listCaseTechniques(db: Pool, caseId: string) {
  await ensureCase(db, caseId);
  const r = await db.query(
    `select t.id, t.name, t.tactics, ct.source, ct.note, ct.added_at, u.username as added_by
     from case_techniques ct
     join attack_techniques t on t.id = ct.technique_id
     left join users u on u.id = ct.added_by
     where ct.case_id = $1 order by t.id`, [caseId]);
  return { techniques: r.rows };
}

export async function addTechnique(
  db: Pool, actor: AuthUser, caseId: string, input: { id: string; note?: string }, ip: string | null,
) {
  const id = parseTechnique(input.id);
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const cat = await c.query('select id, name, tactics from attack_techniques where id = $1', [id]);
    if (!cat.rowCount) {
      throw new HttpError(404, 'unknown_technique', `${id} is not in the technique catalog (import the full ATT&CK catalog to add more)`);
    }
    const ins = await c.query(
      `insert into case_techniques (case_id, technique_id, source, note, added_by)
       values ($1, $2, 'manual', $3, $4) on conflict do nothing`,
      [caseId, id, input.note ?? '', actor.id]);
    if (!ins.rowCount) throw new HttpError(409, 'technique_already_tagged', 'This technique is already on the case');
    const { name, tactics } = cat.rows[0];
    await addEvent(c, caseId, actor.id, 'technique_added', { id, name });
    await appendAudit(c, {
      actorId: actor.id, actorName: who(actor), action: 'technique.added',
      entity: 'case', entityId: caseId, ip, detail: { id, name },
    });
    return { id, name, tactics };
  });
}

export async function removeTechnique(db: Pool, actor: AuthUser, caseId: string, rawId: string, ip: string | null) {
  const id = parseTechnique(rawId);
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const del = await c.query(
      'delete from case_techniques where case_id = $1 and technique_id = $2 returning technique_id', [caseId, id]);
    if (!del.rowCount) throw new HttpError(404, 'technique_not_found', 'That technique is not on this case');
    await addEvent(c, caseId, actor.id, 'technique_removed', { id });
    await appendAudit(c, {
      actorId: actor.id, actorName: who(actor), action: 'technique.removed',
      entity: 'case', entityId: caseId, ip, detail: { id },
    });
    return { removed: true };
  });
}

export async function searchTechniques(db: Pool, q: string) {
  const r = await db.query(
    `select id, name, tactics from attack_techniques
     where ($1 = '' or id ilike $2 escape '\\' or name ilike $2 escape '\\')
     order by id limit 25`, [q, `%${esc(q)}%`]);
  return { techniques: r.rows };
}