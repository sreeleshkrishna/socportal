create table evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (case_id, name)
);

create table evidence_versions (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references evidence(id) on delete cascade,
  version int not null check (version > 0),
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (length(sha256) = 64),
  object_key text not null unique,
  enc_iv text not null,
  enc_tag text not null,
  uploaded_by uuid references users(id),
  uploaded_at timestamptz not null default now(),
  unique (evidence_id, version)
);

create table custody_log (
  id bigint generated always as identity primary key,
  version_id uuid not null references evidence_versions(id) on delete cascade,
  case_id uuid not null,
  action text not null check (action in ('uploaded','downloaded','verified','verify_failed')),
  actor_id uuid references users(id),
  actor_name text not null,
  sha256 text not null,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index custody_log_version_idx on custody_log(version_id, id);

create function evidence_block_changes() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: evidence records are immutable', tg_op, tg_table_name using errcode = '42501';
end;
$$;

create trigger evidence_versions_immutable before update or delete on evidence_versions
  for each row execute function evidence_block_changes();
create trigger custody_log_immutable before update or delete on custody_log
  for each row execute function evidence_block_changes();