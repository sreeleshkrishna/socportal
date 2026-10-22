function Get-SocToken($u) {
  (Invoke-RestMethod -Method Post -Uri http://localhost:8180/realms/soc/protocol/openid-connect/token `
    -Body @{client_id='soc-portal';grant_type='password';username=$u;password='Passw0rd!dev'}).access_token
}

function Api($method, $path, $user, $body = $null) {
  $h = @{ Authorization = "Bearer $(Get-SocToken $user)" }
  $uri = "http://localhost:4000$path"
  try {
    if ($body) { Invoke-RestMethod -Method $method -Uri $uri -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 5) }
    else       { Invoke-RestMethod -Method $method -Uri $uri -Headers $h }
  } catch {
    Write-Host "HTTP $([int]$_.Exception.Response.StatusCode)  $($_.ErrorDetails.Message)" -ForegroundColor Yellow
  }
}
