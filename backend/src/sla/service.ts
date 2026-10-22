import type { Pool, PoolClient } from 'pg';

export type SlaState = 'ok' | 'warning' | 'breached' | 'met';

export interface SlaRow {
  respond_warn_at: Date; respond_due: Date; resolve_warn_at: Date; resolve_due: Date;
  responded_at: Date | null; resolved_at: Date | null;
}

// (Re)calculate due times from the case's creation time and current severity.
// Warned/breached markers are kept, so nothing is notified twice.
export async function upsertSla(c: Pool | PoolClient, caseId: string) {
  await c.query(
    `insert into case_sla (case_id, respond_warn_at, respond_due, resolve_warn_at, resolve_due)
     select cs.id,
       cs.created_at + make_interval(secs => (p.respond_minutes * 60 * p.warn_percent / 100.0)::double precision),
       cs.created_at + make_interval(secs => (p.respond_minutes * 60)::double precision),
       cs.created_at + make_interval(secs => (p.resolve_minutes * 60 * p.warn_percent / 100.0)::double precision),
       cs.created_at + make_interval(secs => (p.resolve_minutes * 60)::double precision)
     from cases cs join sla_policies p on p.severity = cs.severity
     where cs.id = $1
     on conflict (case_id) do update set
       respond_warn_at = excluded.respond_warn_at, respond_due = excluded.respond_due,
       resolve_warn_at = excluded.resolve_warn_at, resolve_due = excluded.resolve_due`,
    [caseId],
  );
}

function phase(done: Date | null, warnAt: Date, dueAt: Date, now: Date): SlaState {
  if (done) return done.getTime() <= dueAt.getTime() ? 'met' : 'breached';
  if (now.getTime() >= dueAt.getTime()) return 'breached';
  if (now.getTime() >= warnAt.getTime()) return 'warning';
  return 'ok';
}

// Computed from timestamps, so the UI is correct even between worker ticks
export function slaSummary(r: SlaRow, now = new Date()) {
  const respond = { due: r.respond_due, state: phase(r.responded_at, r.respond_warn_at, r.respond_due, now), done_at: r.responded_at };
  const resolve = { due: r.resolve_due, state: phase(r.resolved_at, r.resolve_warn_at, r.resolve_due, now), done_at: r.resolved_at };
  const states = [respond.state, resolve.state];
  const overall: SlaState = states.includes('breached') ? 'breached'
    : states.includes('warning') ? 'warning'
    : states.every((s) => s === 'met') ? 'met' : 'ok';
  return { respond, resolve, overall };
}