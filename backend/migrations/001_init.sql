create table users (
  id uuid primary key,                 -- Keycloak "sub"
  username text not null,
  email text,
  created_at timestamptz not null default now()
);

create table cases (
  id uuid primary key default gen_random_uuid(),
  case_number bigint generated always as identity unique,
  title text not null,
  description text not null default '',
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'new' check (status in
    ('new','triage','in_progress','escalated','contained','resolved','closed')),
  assigned_to uuid references users(id),
  created_by uuid references users(id),
  source text not null default 'manual',
  closure_reason text,
  resolution_summary text,
  fingerprint text,
  alert_count int not null default 0,
  last_alert_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index cases_status_idx on cases(status);
create index cases_assigned_idx on cases(assigned_to);
create index cases_created_idx on cases(created_at desc);
create index cases_fingerprint_idx on cases(fingerprint) where fingerprint is not null;

create table case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  author_id uuid references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

-- Activity history / timeline (the tamper-evident audit chain comes in Week 6)
create table case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references cases(id) on delete cascade,
  actor_id uuid references users(id),   -- null = system / SIEM
  type text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index case_events_case_idx on case_events(case_id, id);