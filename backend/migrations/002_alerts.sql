create table alerts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  source text not null,
  external_id text,
  rule_id text,
  rule_name text,
  severity text not null,
  host text,
  src_ip text,
  fingerprint text not null,
  raw_payload jsonb not null,
  event_time timestamptz,
  received_at timestamptz not null default now()
);
create unique index alerts_source_external_uq on alerts(source, external_id) where external_id is not null;
create index alerts_fingerprint_idx on alerts(fingerprint, received_at desc);
create index alerts_case_idx on alerts(case_id);