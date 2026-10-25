# Fills a clean stack with a believable set of cases. Run within an hour of the demo.
Set-Location (Split-Path $PSScriptRoot -Parent)
. .\backend\scripts\soc-helpers.ps1

# Wait for sign-in: Keycloak needs a minute or two after a fresh start
Write-Host -NoNewline 'Waiting for sign-in '
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  try { $null = Get-SocToken 't1.alice'; $ready = $true }
  catch { Write-Host -NoNewline '.'; Start-Sleep -Seconds 3 }
}
if (-not $ready) { Write-Host ' not ready. Check: docker compose ps -a'; exit 1 }
Write-Host ' ready'

# Register all five users (a user must call the API once before cases can name them)
't1.alice','t2.bob','ir.carol','mgr.dave','aud.erin' | ForEach-Object { Api GET /api/me $_ | Out-Null }

function Advance($id, $user, $to, $extra = @{}) {
  Api POST "/api/cases/$id/transition" $user (@{ to = $to } + $extra) | Out-Null
}

# 1) Phishing case in progress (used to show the checklist rule)
$a = Api POST /api/cases t1.alice @{ title = 'Finance reports a fake invoice email'; severity = 'high'; playbook = 'phishing' }
Advance $a.id t1.alice 'triage'
Advance $a.id t1.alice 'in_progress'
Api POST "/api/cases/$($a.id)/iocs" t1.alice @{ value = 'hxxps://invoice-portal[.]evil-example[.]com/login'; note = 'link in the email' } | Out-Null
Api POST "/api/cases/$($a.id)/iocs" t1.alice @{ value = '203.0.113.50'; note = 'sender IP' } | Out-Null
Api POST "/api/cases/$($a.id)/techniques" t1.alice @{ id = 'T1566.002' } | Out-Null

# 2) Escalated malware case that shares the same IP
$b = Api POST /api/cases t2.bob @{ title = 'Ransom note found on an HR laptop'; severity = 'critical'; playbook = 'malware' }
Advance $b.id t2.bob 'triage'
Advance $b.id t2.bob 'in_progress'
Api POST "/api/cases/$($b.id)/escalate" t2.bob @{ reason = 'Possible ransomware, needs the incident responder' } | Out-Null
Api POST "/api/cases/$($b.id)/iocs" t2.bob @{ value = '203.0.113.50'; note = 'download source' } | Out-Null
Api POST "/api/cases/$($b.id)/techniques" t2.bob @{ id = 'T1486' } | Out-Null

# 3) A new case waiting for triage
Api POST /api/cases t1.alice @{ title = 'Unusual VPN login from a new country'; severity = 'medium' } | Out-Null

# 4) Two finished cases so the dashboard has resolution times
$c = Api POST /api/cases t1.alice @{ title = 'Expired certificate on the intranet'; severity = 'low' }
Advance $c.id t2.bob 'triage'
Advance $c.id t2.bob 'in_progress'
Advance $c.id t2.bob 'contained'
Advance $c.id t2.bob 'resolved' @{ summary = 'Certificate renewed and monitored' }
Advance $c.id ir.carol 'closed'

$d = Api POST /api/cases t1.alice @{ title = 'Scanner alert on a test server'; severity = 'low' }
Advance $d.id t1.alice 'triage'
Advance $d.id ir.carol 'closed' @{ reason = 'False positive: authorised vulnerability scan' }

$total = (Api GET '/api/cases?limit=50' mgr.dave).total
Write-Host "Demo data ready: $total cases."