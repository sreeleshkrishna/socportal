create table iocs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('ip','domain','url','email','md5','sha1','sha256')),
  value text not null check (length(value) between 1 and 2000),
  created_at timestamptz not null default now(),
  unique (type, value)
);

create table case_iocs (
  case_id uuid not null references cases(id) on delete cascade,
  ioc_id uuid not null references iocs(id) on delete restrict,
  source text not null default 'manual' check (source in ('manual','siem')),
  note text not null default '',
  added_by uuid references users(id),
  added_at timestamptz not null default now(),
  primary key (case_id, ioc_id)
);
create index case_iocs_ioc_idx on case_iocs(ioc_id);

create table attack_techniques (
  id text primary key check (id ~ '^T[0-9]{4}(\.[0-9]{3})?$'),
  name text not null,
  tactics text[] not null default '{}'
);

create table case_techniques (
  case_id uuid not null references cases(id) on delete cascade,
  technique_id text not null references attack_techniques(id),
  source text not null default 'manual' check (source in ('manual','siem')),
  note text not null default '',
  added_by uuid references users(id),
  added_at timestamptz not null default now(),
  primary key (case_id, technique_id)
);
create index case_techniques_tech_idx on case_techniques(technique_id);

-- Starter subset of MITRE ATT&CK Enterprise. Run scripts/import-attack.ts for the full, current catalog.
insert into attack_techniques (id, name, tactics) values
('T1595','Active Scanning','{"Reconnaissance"}'),
('T1566','Phishing','{"Initial Access"}'),
('T1566.001','Spearphishing Attachment','{"Initial Access"}'),
('T1566.002','Spearphishing Link','{"Initial Access"}'),
('T1190','Exploit Public-Facing Application','{"Initial Access"}'),
('T1133','External Remote Services','{"Initial Access","Persistence"}'),
('T1078','Valid Accounts','{"Initial Access","Persistence","Privilege Escalation","Defense Evasion"}'),
('T1059','Command and Scripting Interpreter','{"Execution"}'),
('T1059.001','PowerShell','{"Execution"}'),
('T1059.003','Windows Command Shell','{"Execution"}'),
('T1059.004','Unix Shell','{"Execution"}'),
('T1204','User Execution','{"Execution"}'),
('T1204.001','Malicious Link','{"Execution"}'),
('T1204.002','Malicious File','{"Execution"}'),
('T1053','Scheduled Task/Job','{"Execution","Persistence","Privilege Escalation"}'),
('T1569','System Services','{"Execution"}'),
('T1547','Boot or Logon Autostart Execution','{"Persistence","Privilege Escalation"}'),
('T1136','Create Account','{"Persistence"}'),
('T1098','Account Manipulation','{"Persistence","Privilege Escalation"}'),
('T1543','Create or Modify System Process','{"Persistence","Privilege Escalation"}'),
('T1055','Process Injection','{"Defense Evasion","Privilege Escalation"}'),
('T1027','Obfuscated Files or Information','{"Defense Evasion"}'),
('T1036','Masquerading','{"Defense Evasion"}'),
('T1070','Indicator Removal','{"Defense Evasion"}'),
('T1562','Impair Defenses','{"Defense Evasion"}'),
('T1112','Modify Registry','{"Defense Evasion"}'),
('T1218','System Binary Proxy Execution','{"Defense Evasion"}'),
('T1140','Deobfuscate/Decode Files or Information','{"Defense Evasion"}'),
('T1110','Brute Force','{"Credential Access"}'),
('T1110.001','Password Guessing','{"Credential Access"}'),
('T1110.002','Password Cracking','{"Credential Access"}'),
('T1110.003','Password Spraying','{"Credential Access"}'),
('T1110.004','Credential Stuffing','{"Credential Access"}'),
('T1003','OS Credential Dumping','{"Credential Access"}'),
('T1056','Input Capture','{"Collection","Credential Access"}'),
('T1539','Steal Web Session Cookie','{"Credential Access"}'),
('T1552','Unsecured Credentials','{"Credential Access"}'),
('T1555','Credentials from Password Stores','{"Credential Access"}'),
('T1557','Adversary-in-the-Middle','{"Credential Access","Collection"}'),
('T1558','Steal or Forge Kerberos Tickets','{"Credential Access"}'),
('T1046','Network Service Discovery','{"Discovery"}'),
('T1018','Remote System Discovery','{"Discovery"}'),
('T1083','File and Directory Discovery','{"Discovery"}'),
('T1082','System Information Discovery','{"Discovery"}'),
('T1087','Account Discovery','{"Discovery"}'),
('T1016','System Network Configuration Discovery','{"Discovery"}'),
('T1033','System Owner/User Discovery','{"Discovery"}'),
('T1049','System Network Connections Discovery','{"Discovery"}'),
('T1135','Network Share Discovery','{"Discovery"}'),
('T1057','Process Discovery','{"Discovery"}'),
('T1021','Remote Services','{"Lateral Movement"}'),
('T1021.001','Remote Desktop Protocol','{"Lateral Movement"}'),
('T1021.004','SSH','{"Lateral Movement"}'),
('T1550','Use Alternate Authentication Material','{"Defense Evasion","Lateral Movement"}'),
('T1005','Data from Local System','{"Collection"}'),
('T1114','Email Collection','{"Collection"}'),
('T1560','Archive Collected Data','{"Collection"}'),
('T1213','Data from Information Repositories','{"Collection"}'),
('T1071','Application Layer Protocol','{"Command and Control"}'),
('T1105','Ingress Tool Transfer','{"Command and Control"}'),
('T1572','Protocol Tunneling','{"Command and Control"}'),
('T1568','Dynamic Resolution','{"Command and Control"}'),
('T1041','Exfiltration Over C2 Channel','{"Exfiltration"}'),
('T1048','Exfiltration Over Alternative Protocol','{"Exfiltration"}'),
('T1567','Exfiltration Over Web Service','{"Exfiltration"}'),
('T1020','Automated Exfiltration','{"Exfiltration"}'),
('T1537','Transfer Data to Cloud Account','{"Exfiltration"}'),
('T1486','Data Encrypted for Impact','{"Impact"}'),
('T1490','Inhibit System Recovery','{"Impact"}'),
('T1485','Data Destruction','{"Impact"}'),
('T1498','Network Denial of Service','{"Impact"}'),
('T1499','Endpoint Denial of Service','{"Impact"}')
on conflict (id) do nothing;