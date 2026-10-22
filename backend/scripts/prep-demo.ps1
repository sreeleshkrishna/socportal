# Fills a clean stack with a believable set of cases. Run from anywhere, within an hour of the demo.
Set-Location (Split-Path $PSScriptRoot -Parent)
. .\backend\scripts\soc-helpers.ps1

't1.alice','t2.bob','ir.carol','mgr.dave','aud.erin' | ForEach-Object { Api GET /api/me $_ | Out-Null }

# note: "move" is a built-in PowerShell alias, so the helper has another name
function Advance($id, $user, $to, $extra = @{}) {
  Api POST "/api/cases/$id/transition" $user (@{ to = $to } + $extra) | Out-Null
}

# 1) phishing case in progress (used to show the checklist gate)
$a = Api POST /api/cases t1.alice @{ title = 'Finance reports a fake invoice email'; severity = 'high'; playbook = 'phishing' }
Advance $a.id t1.alice 'triage'; Advance $a.id t1.alice 'in_progress'
Api POST "/api/cases/$($a.id)/iocs" t1.alice @{ value = 'hxxps://invoice-portal[.]evil-example[.]com/login'; note = 'link in the email' } | Out-Null
Api POST "/api/cases/$($a.id)/iocs" t1.alice @{ value = '203.0.113.50'; note = 'sender IP' } | Out-Null
Api POST "/api/cases/$($a.id)/techniques" t1.alice @{ id = 'T1566.002' } | Out-Null

# 2) escalated malware case that shares the same IP
$b = Api POST /api/cases t2.bob @{ title = 'Ransom note found on an HR laptop'; severity = 'critical'; playbook = 'malware' }
Advance $b.id t2.bob 'triage'; Advance $b.id t2.bob 'in_progress'
Api POST "/api/cases/$($b.id)/escalate" t2.bob @{ reason = 'Possible ransomware, needs the incident responder' } | Out-Null
Api POST "/api/cases/$($b.id)/iocs" t2.bob @{ value = '203.0.113.50'; note = 'download source' } | Out-Null
Api POST "/api/cases/$($b.id)/techniques" t2.bob @{ id = 'T1486' } | Out-Null

# 3) a new case waiting for triage
Api POST /api/cases t1.alice @{ title = 'Unusual VPN login from a new country'; severity = 'medium' } | Out-Null

# 4) two finished cases so the dashboard shows resolution times
$c = Api POST /api/cases t1.alice @{ title = 'Expired certificate on the intranet'; severity = 'low' }
Advance $c.id t2.bob 'triage'; Advance $c.id t2.bob 'in_progress'; Advance $c.id t2.bob 'contained'
Advance $c.id t2.bob 'resolved' @{ summary = 'Certificate renewed and monitored' }
Advance $c.id ir.carol 'closed'
$d = Api POST /api/cases t1.alice @{ title = 'Scanner alert on a test server'; severity = 'low' }
Advance $d.id t1.alice 'triage'
Advance $d.id ir.carol 'closed' @{ reason = 'False positive: authorised vulnerability scan' }

Write-Host 'Demo data ready.'