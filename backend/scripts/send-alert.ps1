param(
  [Parameter(Mandatory)][string]$File,
  [string]$Source = 'wazuh',
  [switch]$NewId          # new alert id each time, so it is not treated as a duplicate
)
$json = Get-Content $File -Raw
if ($NewId) {
  $o = $json | ConvertFrom-Json
  $prop = if ($o.PSObject.Properties.Name -contains 'alert_id') { 'alert_id' } else { 'id' }
  $o | Add-Member -NotePropertyName $prop -NotePropertyValue ([guid]::NewGuid().ToString()) -Force
  $json = $o | ConvertTo-Json -Depth 20
}
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/webhooks/alerts/$Source" `
  -Headers @{ 'X-Webhook-Token' = $env:WEBHOOK_SECRET } -ContentType 'application/json' -Body $json