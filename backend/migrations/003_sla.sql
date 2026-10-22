alter table users add column roles text[] not null default '{}';

create table sla_policies (
  severity text primary key check (severity in ('low','medium','high','critical')),
  respond_minutes int not null check (respond_minutes > 0),
  resolve_minutes int not null check (resolve_minutes > 0),
  warn_percent int not null default 80 check (warn_percent between 1 and 99)
);
insert into sla_policies (severity, respond_minutes, resolve_minutes) values
  ('critical', 15, 240), ('high', 30, 480), ('medium', 120, 1440), ('low', 480, 4320);

create table case_sla (
  case_id uuid primary key references cases(id) on delete cascade,
  respond_warn_at timestamptz not null,
  respond_due timestamptz not null,
  resolve_warn_at timestamptz not null,
  resolve_due timestamptz not null,
  responded_at timestamptz,
  resolved_at timestamptz,
  respond_warned_at timestamptz,
  respond_breached_at timestamptz,
  resolve_warned_at timestamptz,
  resolve_breached_at timestamptz
);
create index case_sla_respond_idx on case_sla(respond_due) where responded_at is null and respond_breached_at is null;
create index case_sla_resolve_idx on case_sla(resolve_due) where resolved_at is null and resolve_breached_at is null;

-- Existing cases get timers too, without retroactive warnings or escalations
insert into case_sla (case_id, respond_warn_at, respond_due, resolve_warn_at, resolve_due, responded_at, resolved_at)
select c.id,
  c.created_at + make_interval(secs => (p.respond_minutes * 60 * p.warn_percent / 100.0)::double precision),
  c.created_at + make_interval(secs => (p.respond_minutes * 60)::double precision),
  c.created_at + make_interval(secs => (p.resolve_minutes * 60 * p.warn_percent / 100.0)::double precision),
  c.created_at + make_interval(secs => (p.resolve_minutes * 60)::double precision),
  case when c.status <> 'new' then c.updated_at end,
  case when c.status in ('resolved','closed') then c.updated_at end
from cases c join sla_policies p on p.severity = c.severity;

update case_sla set respond_warned_at = now(),
  respond_breached_at = case when respond_due <= now() then now() end
 where responded_at is null and respond_warn_at <= now();
update case_sla set resolve_warned_at = now(),
  resolve_breached_at = case when resolve_due <= now() then now() end
 where resolved_at is null and resolve_warn_at <= now();

create table notifications (
  id bigint generated always as identity primary key,
  case_id uuid references cases(id) on delete cascade,
  kind text not null,
  channel text not null check (channel in ('email','slack')),
  recipient text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_pending_idx on notifications(id) where status = 'pending';