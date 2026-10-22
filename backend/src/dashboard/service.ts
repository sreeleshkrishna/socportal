import type { Pool } from 'pg';

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const pct = (met: number, missed: number) =>
  met + missed === 0 ? null : Math.round((met / (met + missed)) * 1000) / 10;

const STATUS_ORDER = ['new', 'triage', 'in_progress', 'escalated', 'contained'];
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const WINDOW = `now() - make_interval(days => $1::int)`;

const OVERDUE = `((s.responded_at is null and s.respond_due < now()) or (s.resolved_at is null and s.resolve_due < now()))`;

export async function getDashboard(db: Pool, days: number) {
  const trendDays = Math.min(days, 90);
  const [kpi, mttd, sla, backlogRows, backlogTotals, workload, trend, severity, techniques] = await Promise.all([
    db.query(
      `select count(*)::int as created,
              count(*) filter (where s.resolved_at is not null)::int as resolved,
              avg(extract(epoch from (s.resolved_at - c.created_at))) filter (where s.resolved_at is not null) as mttr,
              avg(extract(epoch from (s.responded_at - c.created_at))) filter (where s.responded_at is not null) as mtta
       from cases c left join case_sla s on s.case_id = c.id
       where c.created_at >= ${WINDOW}`, [days]),
    db.query(
      `select avg(greatest(0, extract(epoch from (c.created_at - a.first_event)))) as mttd, count(*)::int as n
       from cases c
       join (select case_id, min(event_time) as first_event from alerts where event_time is not null group by case_id) a
         on a.case_id = c.id
       where c.created_at >= ${WINDOW}`, [days]),
    db.query(
      `select
         count(*) filter (where s.responded_at is not null and s.responded_at <= s.respond_due)::int as respond_met,
         count(*) filter (where (s.responded_at is not null and s.responded_at > s.respond_due)
                             or (s.responded_at is null and s.respond_due < now()))::int as respond_missed,
         count(*) filter (where s.resolved_at is not null and s.resolved_at <= s.resolve_due)::int as resolve_met,
         count(*) filter (where (s.resolved_at is not null and s.resolved_at > s.resolve_due)
                             or (s.resolved_at is null and s.resolve_due < now()))::int as resolve_missed
       from cases c join case_sla s on s.case_id = c.id
       where c.created_at >= ${WINDOW}`, [days]),
    db.query(
      `select status, severity, count(*)::int as n from cases
       where status not in ('resolved', 'closed') group by status, severity`),
    db.query(
      `select count(*)::int as open,
              count(*) filter (where c.assigned_to is null)::int as unassigned,
              count(*) filter (where ${OVERDUE})::int as overdue,
              max(extract(epoch from (now() - c.created_at))) as oldest
       from cases c left join case_sla s on s.case_id = c.id
       where c.status not in ('resolved', 'closed')`),
    db.query(
      `select u.username,
              count(*) filter (where c.status not in ('resolved', 'closed'))::int as open,
              count(*) filter (where c.status not in ('resolved', 'closed') and c.severity in ('critical', 'high'))::int as open_high,
              count(*) filter (where c.status not in ('resolved', 'closed') and ${OVERDUE})::int as overdue,
              count(*) filter (where s.resolved_at >= ${WINDOW})::int as resolved_in_period
       from users u
       join cases c on c.assigned_to = u.id
       left join case_sla s on s.case_id = c.id
       group by u.id, u.username
       order by open desc, u.username`, [days]),
    db.query(
      `with d as (
         select generate_series(
           date_trunc('day', now()) - make_interval(days => $1::int - 1),
           date_trunc('day', now()), interval '1 day') as day)
       select to_char(d.day, 'YYYY-MM-DD') as day,
              (select count(*)::int from cases c
                 where c.created_at >= d.day and c.created_at < d.day + interval '1 day') as created,
              (select count(*)::int from case_sla s
                 where s.resolved_at >= d.day and s.resolved_at < d.day + interval '1 day') as resolved
       from d order by d.day`, [trendDays]),
    db.query(
      `select severity, count(*)::int as n from cases where created_at >= ${WINDOW} group by severity`, [days]),
    db.query(
      `select t.id, t.name, count(*)::int as n
       from case_techniques ct
       join attack_techniques t on t.id = ct.technique_id
       join cases c on c.id = ct.case_id
       where c.created_at >= ${WINDOW}
       group by t.id, t.name order by n desc, t.id limit 8`, [days]),
  ]);

  const s = sla.rows[0];
  const bt = backlogTotals.rows[0];
  const sum = (rows: Array<{ n: number }>) => rows.reduce((a, r) => a + r.n, 0);

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    kpis: {
      created: kpi.rows[0].created as number,
      resolved: kpi.rows[0].resolved as number,
      mttrSeconds: num(kpi.rows[0].mttr),
      mttaSeconds: num(kpi.rows[0].mtta),
      mttdSeconds: num(mttd.rows[0].mttd),
      mttdSamples: mttd.rows[0].n as number,
    },
    sla: {
      respond: { met: s.respond_met, missed: s.respond_missed, compliancePercent: pct(s.respond_met, s.respond_missed) },
      resolve: { met: s.resolve_met, missed: s.resolve_missed, compliancePercent: pct(s.resolve_met, s.resolve_missed) },
    },
    backlog: {
      open: bt.open as number,
      unassigned: bt.unassigned as number,
      overdue: bt.overdue as number,
      oldestSeconds: num(bt.oldest),
      byStatus: STATUS_ORDER.map((st) => ({ status: st, count: sum(backlogRows.rows.filter((r) => r.status === st)) })),
      bySeverity: SEVERITY_ORDER.map((sv) => ({ severity: sv, count: sum(backlogRows.rows.filter((r) => r.severity === sv)) })),
    },
    workload: workload.rows.map((w) => ({
      username: w.username as string, open: w.open as number, openHigh: w.open_high as number,
      overdue: w.overdue as number, resolvedInPeriod: w.resolved_in_period as number,
    })),
    trend: trend.rows as Array<{ day: string; created: number; resolved: number }>,
    severity: SEVERITY_ORDER.map((sv) => ({ severity: sv, count: sum(severity.rows.filter((r) => r.severity === sv)) })),
    topTechniques: techniques.rows.map((t) => ({ id: t.id as string, name: t.name as string, count: t.n as number })),
  };
}