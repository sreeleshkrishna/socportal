# Takes a fresh backup, restores it into a scratch database, compares it with the live data
# and verifies the audit hash chain of the restored copy.  Run from anywhere:  .\scripts\restore-test.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)
$scratch = 'socportal_restore_test'
$failures = 0

function Dc { docker compose @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }
function Sql($db, $sql) { (docker compose exec -T db psql -U soc -d $db -t -A -c $sql 2>$null | Out-String).Trim() }

try {
  Write-Host '1. stopping writers (api, worker, gateway) so the numbers can be compared'
  Dc stop worker api gateway

  Write-Host '2. taking a fresh backup'
  Dc exec -T backup sh -c 'pg_dump -h db -U soc -d socportal -Fc -f /backups/socportal-restoretest.dump'

  Write-Host '3. restoring into a scratch database'
  Dc exec -T db psql -U soc -d postgres -c "drop database if exists $scratch"
  Dc exec -T db psql -U soc -d postgres -c "create database $scratch"
  Dc exec -T backup sh -c "pg_restore -h db -U soc -d $scratch --no-owner /backups/socportal-restoretest.dump"

  Write-Host '4. comparing row counts'
  foreach ($t in 'users','cases','case_events','alerts','evidence','evidence_versions','custody_log','audit_log','iocs','case_techniques','case_tasks','notifications') {
    $live = Sql 'socportal' "select count(*) from $t"
    $copy = Sql $scratch "select count(*) from $t"
    $ok = ($live -eq $copy) -and ($live -ne '')
    if (-not $ok) { $failures++ }
    '{0,-18} live={1,-8} restored={2,-8} {3}' -f $t, $live, $copy, $(if ($ok) { 'OK' } else { 'DIFFERENT' })
  }

  Write-Host '5. comparing the audit chain head'
  $head = 'select hash from audit_log order by seq desc limit 1'
  $h1 = Sql 'socportal' $head; $h2 = Sql $scratch $head
  if ($h1 -eq $h2 -and $h1) { Write-Host "chain head identical: $h1" } else { $failures++; Write-Host 'chain head DIFFERENT' -ForegroundColor Red }

  Write-Host '6. verifying the audit chain of the restored copy'
  $url = (Get-Content backend\.env | Where-Object { $_ -like 'DATABASE_URL=*' }) -replace '^DATABASE_URL=', ''
  $env:DATABASE_URL = $url -replace '/socportal$', "/$scratch"
  Push-Location backend
  npx tsx scripts/verify-chain.ts
  if ($LASTEXITCODE -ne 0) { $failures++ }
  Pop-Location
  Remove-Item Env:\DATABASE_URL
}
catch {
  $failures++
  Write-Host "error: $_" -ForegroundColor Red
}
finally {
  Write-Host '7. cleaning up and restarting the stack'
  docker compose exec -T db psql -U soc -d postgres -c "drop database if exists $scratch" 2>&1 | Out-Null
  docker compose start worker api gateway 2>&1 | Out-Null
}

if ($failures -eq 0) { Write-Host 'RESTORE TEST PASSED' -ForegroundColor Green; exit 0 }
Write-Host "RESTORE TEST FAILED ($failures problem(s))" -ForegroundColor Red
exit 1