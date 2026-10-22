create table audit_log (
  seq bigint generated always as identity primary key,
  at timestamptz not null,
  actor_id uuid,
  actor_name text not null,
  action text not null,
  entity text,
  entity_id text,
  ip text,
  detail jsonb not null default '{}',
  prev_hash text not null check (length(prev_hash) = 64),
  hash text not null unique check (length(hash) = 64)
);
create index audit_log_action_idx on audit_log(action, seq desc);
create index audit_log_entity_idx on audit_log(entity, entity_id, seq desc);
create index audit_log_actor_idx on audit_log(actor_name, seq desc);

create function audit_log_block_changes() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete before update or delete on audit_log
  for each row execute function audit_log_block_changes();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_block_changes();