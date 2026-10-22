create table playbooks (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null default ''
);

create table playbook_tasks (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references playbooks(id) on delete cascade,
  position int not null,
  title text not null,
  description text not null default '',
  unique (playbook_id, position)
);

alter table cases add column playbook_id uuid references playbooks(id);

create table case_tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  position int not null,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','done','skipped')),
  assignee_id uuid references users(id),
  completed_by uuid references users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index case_tasks_case_idx on case_tasks(case_id, position);

insert into playbooks (key, name, description) values
  ('phishing', 'Phishing', 'Reported or detected phishing email'),
  ('malware', 'Malware', 'Malware or ransomware on an endpoint'),
  ('brute-force', 'Brute force', 'Repeated failed logins or password guessing'),
  ('data-exfiltration', 'Data exfiltration', 'Suspected unauthorised data transfer');

insert into playbook_tasks (playbook_id, position, title, description)
select p.id, v.position, v.title, v.description
from playbooks p
join (values
  ('phishing', 1, 'Record the reported email', 'Capture sender, subject, message ID and time received. Keep the original message as evidence.'),
  ('phishing', 2, 'Check email headers', 'Review SPF, DKIM and DMARC results and the real sending server.'),
  ('phishing', 3, 'Analyse links and attachments', 'Inspect URLs and attachment hashes in a sandbox or with a reputation service. Use lab or public data only.'),
  ('phishing', 4, 'Find all recipients', 'Search mail logs for the same sender, subject or URL to see who else received it.'),
  ('phishing', 5, 'Check for clicks or credential entry', 'Review proxy and authentication logs for users who opened the link or submitted credentials.'),
  ('phishing', 6, 'Block and remove', 'Block the sender, domain and URLs, and purge the message from mailboxes.'),
  ('phishing', 7, 'Reset affected accounts', 'Reset passwords and revoke sessions for any user who entered credentials.'),
  ('phishing', 8, 'Record IOCs and notify users', 'Add indicators to the case, notify recipients and note lessons learned.'),
  ('malware', 1, 'Isolate the host', 'Disconnect the affected host from the network without powering it off.'),
  ('malware', 2, 'Preserve volatile evidence', 'Capture running processes, network connections and memory if possible.'),
  ('malware', 3, 'Identify the sample', 'Collect the file, record its SHA-256 hash and check it against reputation sources.'),
  ('malware', 4, 'Scope the infection', 'Search other hosts for the same hash, process names, domains and IP addresses.'),
  ('malware', 5, 'Eradicate', 'Remove the malware and persistence mechanisms, or rebuild the host.'),
  ('malware', 6, 'Recover', 'Restore from a known-good state and verify the host is clean before reconnecting.'),
  ('malware', 7, 'Monitor and report', 'Watch the host and related indicators for recurrence, then document the incident.'),
  ('brute-force', 1, 'Identify sources and targets', 'List the source IP addresses and the accounts or services being attacked.'),
  ('brute-force', 2, 'Check for successful logins', 'Look for a successful authentication from the same source after the failures.'),
  ('brute-force', 3, 'Secure affected accounts', 'Lock or reset any account that was successfully accessed or heavily targeted.'),
  ('brute-force', 4, 'Block the source', 'Block the attacking IP addresses at the firewall or with a rate limit.'),
  ('brute-force', 5, 'Check for follow-on activity', 'Review logs of any compromised account for lateral movement or persistence.'),
  ('brute-force', 6, 'Harden and document', 'Enable MFA or lockout rules where missing and record findings in the case.'),
  ('data-exfiltration', 1, 'Confirm the activity', 'Verify the transfer is not legitimate by checking with the data owner.'),
  ('data-exfiltration', 2, 'Identify the data', 'Determine what data left, how sensitive it is and how much.'),
  ('data-exfiltration', 3, 'Identify the channel', 'Find the destination, protocol and account or host that was used.'),
  ('data-exfiltration', 4, 'Contain', 'Block the destination and disable the account or host involved.'),
  ('data-exfiltration', 5, 'Preserve evidence', 'Keep network logs, file access logs and affected endpoint images with chain of custody.'),
  ('data-exfiltration', 6, 'Assess notification duties', 'Work with management and legal to decide whether customers or regulators must be told.'),
  ('data-exfiltration', 7, 'Review and improve', 'Record root cause and add monitoring or controls to prevent a repeat.')
) as v(key, position, title, description) on v.key = p.key;