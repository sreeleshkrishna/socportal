import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { withTx } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { applyPlaybook } from '../playbooks/service.js';
import { slaSummary, upsertSla } from '../sla/service.js';
import { addEvent } from './events.js';
import { checkTransition, TRANSITIONS, type Status } from './stateMachine.js';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface CaseRow {
  id: string; case_number: string; title: string; description: string;
  severity: Severity; status: Status; assigned_to: string | null; created_by: string | null;
  source: string; closure_reason: string | null; resolution_summary: string | null;
  playbook_id: string | null;
  alert_count: number; created_at: Date; updated_at: Date; closed_at: Date | null;
}

export interface ListFilters {
  status?: string; severity?: string; assignee?: string; q?: string; limit: number; offset: number;
}

const LIST_COLS = `cases.id, case_number, title, severity, status, assigned_to, source, alert_count, created_at, updated_at,
  s.respond_warn_at, s.respond_due, s.resolve_warn_at, s.resolve_due, s.responded_at, s.resolved_at`;

export async function listCases(db: Pool, f: ListFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.status) add('status = ?', f.status);
  if (f.severity) add('severity = ?', f.severity);
  if (f.assignee) add('assigned_to = ?', f.assignee);
  if (f.q) add(`title ilike ? escape '\\'`, `%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  const total = await db.query(`select count(*)::int as n from cases ${clause}`, params);
  const rows = await db.query(
    `select ${LIST_COLS} from cases left join case_sla s on s.case_id = cases.id ${clause}
     order by created_at desc, case_number desc
     limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );
  const cases = rows.rows.map((r) => {
    const { respond_warn_at, respond_due, resolve_warn_at, resolve_due, responded_at, resolved_at, ...rest } = r;
    const sla = respond_due
      ? slaSummary({ respond_warn_at, respond_due, resolve_warn_at, resolve_due, responded_at, resolved_at })
      : null;
    return { ...rest, sla };
  });
  return { cases, total: total.rows[0].n as number, limit: f.limit, offset: f.offset };
}

export async function lockCase(c: PoolClient, id: string): Promise<CaseRow> {
  const r = await c.query('select * from cases where id = $1 for update', [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Case not found');
  return r.rows[0] as CaseRow;
}

export const assertOpen = (row: CaseRow) => {
  if (row.status === 'closed') throw new HttpError(409, 'case_closed', 'Closed cases cannot be changed');
};

export async function createCase(
  db: Pool, actor: AuthUser,
  input: { title: string; description?: string; severity: Severity; playbook?: string },
) {
  return withTx(db, async (c) => {
    const r = await c.query(
      `insert into cases (title, description, severity, created_by) values ($1, $2, $3, $4) returning *`,
      [input.title, input.description ?? '', input.severity, actor.id],
    );
    const row = r.rows[0] as CaseRow;
    await addEvent(c, row.id, actor.id, 'case_created', { severity: input.severity });
    await upsertSla(c, row.id);
    if (input.playbook) await applyPlaybook(c, row.id, input.playbook, actor.id);
    return row;
  });
}

export async function getCase(db: Pool, id: string) {
  const c = await db.query('select * from cases where id = $1', [id]);
  if (!c.rowCount) throw new HttpError(404, 'not_found', 'Case not found');
  const row = c.rows[0] as CaseRow;
  const notes = await db.query(
    `select n.id, n.body, n.created_at, u.username as author from case_notes n
     left join users u on u.id = n.author_id where n.case_id = $1 order by n.created_at`, [id]);
  const events = await db.query(
    `select e.id, e.type, e.detail, e.created_at, u.username as actor from case_events e
     left join users u on u.id = e.actor_id where e.case_id = $1 order by e.id`, [id]);
  const alerts = await db.query(
    `select id, source, rule_id, rule_name, severity, host, src_ip, event_time, received_at
     from alerts where case_id = $1 order by received_at desc limit 100`, [id]);
  const tasks = await db.query(
    `select t.id, t.position, t.title, t.description, t.status, t.completed_at,
            u.username as assignee, cu.username as completed_by
     from case_tasks t
     left join users u on u.id = t.assignee_id
     left join users cu on cu.id = t.completed_by
     where t.case_id = $1 order by t.position`, [id]);
  const sla = await db.query('select * from case_sla where case_id = $1', [id]);
  const playbook = row.playbook_id
    ? (await db.query('select key, name from playbooks where id = $1', [row.playbook_id])).rows[0]
    : null;
  return {
    ...row, notes: notes.rows, events: events.rows, alerts: alerts.rows, tasks: tasks.rows,
    playbook, sla: sla.rowCount ? slaSummary(sla.rows[0]) : null,
  };
}

export async function updateCase(
  db: Pool, actor: AuthUser, id: string,
  patch: { title?: string; description?: string; severity?: Severity },
) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, id));
    // Keys come from the zod-validated object (unknown keys are stripped), never from raw input.
    const params: unknown[] = [id];
    const sets = Object.entries(patch).map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; });
    const r = await c.query(`update cases set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, params);
    if (patch.severity) await upsertSla(c, id); // new severity, new deadlines
    await addEvent(c, id, actor.id, 'case_updated', patch);
    return r.rows[0] as CaseRow;
  });
}

export async function assignCase(db: Pool, actor: AuthUser, id: string, assigneeId: string | null) {
  return withTx(db, async (c) => {
    const cur = await lockCase(c, id);
    assertOpen(cur);
    if (assigneeId) {
      const u = await c.query('select 1 from users where id = $1', [assigneeId]);
      if (!u.rowCount) throw new HttpError(400, 'unknown_assignee', 'That user has never logged in');
    }
    const r = await c.query('update cases set assigned_to = $2, updated_at = now() where id = $1 returning *', [id, assigneeId]);
    const type = !assigneeId ? 'unassigned' : cur.assigned_to ? 'reassigned' : 'assigned';
    await addEvent(c, id, actor.id, type, { from: cur.assigned_to, to: assigneeId });
    return r.rows[0] as CaseRow;
  });
}

export async function transitionCase(
  db: Pool, actor: AuthUser, id: string, to: Status, input: { reason?: string; summary?: string },
) {
  return withTx(db, async (c) => {
    const cur = await lockCase(c, id);
    const check = checkTransition(cur.status, to, actor.roles, input);
    if (!check.ok) throw new HttpError(check.status, check.code, check.message);

    if (to === 'resolved') {
      const open = await c.query(
        `select count(*)::int as n from case_tasks where case_id = $1 and status in ('todo', 'in_progress')`, [id]);
      if (open.rows[0].n > 0) {
        throw new HttpError(409, 'open_tasks', `${open.rows[0].n} playbook task(s) are still open`);
      }
    }

    // Moving New -> Triage claims the case if nobody owns it yet
    const r = await c.query(
      `update cases set
         status = $2::text,
         assigned_to = case when $2::text = 'triage' and assigned_to is null then $3::uuid else assigned_to end,
         closure_reason = case when $2::text = 'closed' then $4::text else closure_reason end,
         resolution_summary = case when $2::text = 'resolved' then $5::text else resolution_summary end,
         closed_at = case when $2::text = 'closed' then now() else closed_at end,
         updated_at = now()
       where id = $1 returning *`,
      [id, to, actor.id, input.reason ?? null, input.summary ?? null],
    );
    // A human moved the case: the respond target is met; resolving or closing meets the resolve target
    await c.query(
      `update case_sla set
         responded_at = coalesce(responded_at, now()),
         resolved_at = case when $2::text in ('resolved', 'closed') then coalesce(resolved_at, now()) else resolved_at end
       where case_id = $1`,
      [id, to],
    );
    await addEvent(c, id, actor.id, 'status_changed', { from: cur.status, to, ...input });
    return r.rows[0] as CaseRow;
  });
}

// Used by the SLA worker inside its own transaction (case row already locked)
export async function systemEscalate(c: PoolClient, row: { id: string; status: Status }, reason: string): Promise<boolean> {
  const t = TRANSITIONS.find((x) => x.from === row.status && x.to === 'escalated');
  if (!t) return false;
  await c.query(`update cases set status = 'escalated', updated_at = now() where id = $1`, [row.id]);
  await addEvent(c, row.id, null, 'status_changed', { from: row.status, to: 'escalated', reason, auto: true });
  return true;
}

export async function addNote(db: Pool, actor: AuthUser, id: string, body: string) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, id));
    const r = await c.query('insert into case_notes (case_id, author_id, body) values ($1, $2, $3) returning *', [id, actor.id, body]);
    await addEvent(c, id, actor.id, 'note_added', { noteId: r.rows[0].id });
    return r.rows[0];
  });
}

export async function listUsers(db: Pool) {
  const r = await db.query('select id, username, email, created_at from users order by username');
  return { users: r.rows };
}