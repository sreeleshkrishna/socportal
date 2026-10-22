// Generates demo cases for performance checks.   npx tsx scripts/seed-cases.ts 10000
// Remove them again with:                         npx tsx scripts/seed-cases.ts --clear
import 'dotenv/config';
import pg from 'pg';
import { config } from '../src/config.js';

const arg = process.argv[2];
const db = new pg.Pool({ connectionString: config.databaseUrl });

const INSERT = `
with new_cases as (
  insert into cases (title, description, severity, status, source, created_at, updated_at, closed_at)
  select 'Seed case ' || g, 'Generated for load testing',
         (array['low','medium','high','critical'])[1 + (g % 4)],
         st.status, 'seed', st.created, st.created + interval '1 hour',
         case when st.status = 'closed' then st.created + interval '3 hours' end
  from generate_series(1, $1::int) as g
  cross join lateral (
    select (array['new','triage','in_progress','escalated','contained','resolved','closed'])[1 + floor(random() * 7)::int] as status,
           now() - random() * interval '30 days' as created
  ) as st
  returning id, status, severity, created_at
)
insert into case_sla (case_id, respond_warn_at, respond_due, resolve_warn_at, resolve_due, responded_at, resolved_at)
select n.id,
  n.created_at + make_interval(secs => (p.respond_minutes * 60 * p.warn_percent / 100.0)::double precision),
  n.created_at + make_interval(secs => (p.respond_minutes * 60)::double precision),
  n.created_at + make_interval(secs => (p.resolve_minutes * 60 * p.warn_percent / 100.0)::double precision),
  n.created_at + make_interval(secs => (p.resolve_minutes * 60)::double precision),
  case when n.status <> 'new' then n.created_at + interval '20 minutes' end,
  case when n.status in ('resolved', 'closed') then n.created_at + interval '3 hours' end
from new_cases n join sla_policies p on p.severity = n.severity`;

// mark past-due timers as already handled so the SLA worker does not escalate or email thousands of seed cases
const MARK_RESPOND = `
update case_sla s set respond_warned_at = now(), respond_breached_at = case when s.respond_due <= now() then now() end
from cases c where c.id = s.case_id and c.source = 'seed' and s.responded_at is null and s.respond_warn_at <= now()`;
const MARK_RESOLVE = `
update case_sla s set resolve_warned_at = now(), resolve_breached_at = case when s.resolve_due <= now() then now() end
from cases c where c.id = s.case_id and c.source = 'seed' and s.resolved_at is null and s.resolve_warn_at <= now()`;

try {
  if (arg === '--clear') {
    const r = await db.query(`delete from cases where source = 'seed'`);
    console.log(`removed ${r.rowCount} seeded cases`);
  } else {
    const n = Number(arg ?? 1000);
    if (!Number.isInteger(n) || n < 1 || n > 50000) throw new Error('usage: tsx scripts/seed-cases.ts <1-50000> | --clear');
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query(INSERT, [n]);
      await c.query(MARK_RESPOND);
      await c.query(MARK_RESOLVE);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    console.log(`seeded ${n} cases`);
  }
} finally {
  await db.end();
}