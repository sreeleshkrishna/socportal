import type { Pool, PoolClient } from 'pg';
import { addEvent } from '../cases/events.js';
import { systemEscalate } from '../cases/service.js';
import type { Status } from '../cases/stateMachine.js';
import { withTx } from '../db/tx.js';
import { enqueueCaseNotification } from '../notify/outbox.js';
import { appendAudit } from '../audit/service.js';

const AUTO_ESCALATE = new Set(['new', 'triage', 'in_progress']);

const HEADLINE: Record<string, string> = {
  respond_warning: 'SLA WARNING: response target is about to be missed',
  resolve_warning: 'SLA WARNING: resolution target is about to be missed',
  respond_breach: 'SLA BREACH: response target missed',
  resolve_breach: 'SLA BREACH: resolution target missed',
};

interface CaseInfo { id: string; case_number: string; title: string; severity: string; assigned_to: string | null }

async function notify(c: PoolClient, row: CaseInfo, kind: string, due: Date, status: string, escalated: boolean) {
  await enqueueCaseNotification(c, {
    caseId: row.id,
    assignedTo: row.assigned_to,
    kind,
    subject: `[SOC] ${HEADLINE[kind]} - Case #${row.case_number} (${row.severity})`,
    body: [
      `Case #${row.case_number}: ${row.title}`,
      `Severity: ${row.severity}`,
      `Status: ${status}`,
      `Owner: ${row.assigned_to ? 'assigned' : 'unassigned'}`,
      `Due: ${due.toISOString()}`,
      escalated ? 'Action: the case was escalated automatically.' : '',
    ].filter(Boolean).join('\n'),
  });
}

// Returns the number of SLA events (warnings + breaches) recorded
export async function runSlaTick(db: Pool): Promise<number> {
  const candidates = await db.query(
    `select s.case_id from case_sla s join cases c on c.id = s.case_id
     where c.status <> 'closed' and (
       (s.responded_at is null and s.respond_warned_at is null and s.respond_warn_at <= now()) or
       (s.responded_at is null and s.respond_breached_at is null and s.respond_due <= now()) or
       (s.resolved_at is null and s.resolve_warned_at is null and s.resolve_warn_at <= now()) or
       (s.resolved_at is null and s.resolve_breached_at is null and s.resolve_due <= now()))
     limit 100`,
  );
  let total = 0;
  for (const row of candidates.rows) total += await processCase(db, row.case_id as string);
  return total;
}

async function processCase(db: Pool, caseId: string): Promise<number> {
  return withTx(db, async (c) => {
    // skip locked: if another worker holds this case, leave it to them
    const r = await c.query(
      `select c.id, c.case_number, c.title, c.severity, c.status, c.assigned_to, now() as db_now, s.*
       from case_sla s join cases c on c.id = s.case_id
       where s.case_id = $1 and c.status <> 'closed'
       for update of s, c skip locked`,
      [caseId],
    );
    if (!r.rowCount) return 0;
    const row = r.rows[0];
    const now: Date = row.db_now;
    let status = row.status as string;
    let count = 0;

    const targets = [
      { name: 'respond' as const, done: row.responded_at, warnAt: row.respond_warn_at, dueAt: row.respond_due, warned: row.respond_warned_at, breached: row.respond_breached_at },
      { name: 'resolve' as const, done: row.resolved_at, warnAt: row.resolve_warn_at, dueAt: row.resolve_due, warned: row.resolve_warned_at, breached: row.resolve_breached_at },
    ];

    for (const t of targets) {
      if (t.done) continue;

      if (!t.warned && t.warnAt <= now) {
        await c.query(`update case_sla set ${t.name}_warned_at = now() where case_id = $1`, [caseId]);
        if (t.dueAt > now) { // no warning if the deadline has already passed
          await addEvent(c, caseId, null, 'sla_warning', { target: t.name, due: t.dueAt });
          await notify(c, row, `${t.name}_warning`, t.dueAt, status, false);
          count++;
        }
      }

      if (!t.breached && t.dueAt <= now) {
        await c.query(`update case_sla set ${t.name}_breached_at = now() where case_id = $1`, [caseId]);
        await addEvent(c, caseId, null, 'sla_breached', { target: t.name, due: t.dueAt });
        count++;
        let escalated = false;
        if (AUTO_ESCALATE.has(status)) {
          escalated = await systemEscalate(c, { id: caseId, status: status as Status }, `SLA breach: ${t.name} target missed`);
          if (escalated) status = 'escalated';
        }
        await notify(c, row, `${t.name}_breach`, t.dueAt, status, escalated);
          await appendAudit(c, {
          actorName: 'system:sla-worker',
          action: 'sla.breach',
          entity: 'case',
          entityId: caseId,
          detail: { target: t.name, escalated, caseNumber: String(row.case_number), status },
        });
      }
    }
    return count;
  });
}