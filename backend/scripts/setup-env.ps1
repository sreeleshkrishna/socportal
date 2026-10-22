# Creates .env (docker compose) and backend\.env with random secrets, if neither exists yet.
$root = Split-Path $PSScriptRoot -Parent
$rootEnv = Join-Path $root '.env'
$backendEnv = Join-Path $root 'backend\.env'

if ((Test-Path $rootEnv) -or (Test-Path $backendEnv)) {
  Write-Host 'An .env file already exists; nothing was changed.'
  exit 0
}

function New-Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

$app = New-Hex 16; $kc = New-Hex 16; $admin = New-Hex 12; $s3 = New-Hex 16
$webhook = New-Hex 32; $evidence = New-Hex 32

[IO.File]::WriteAllLines($rootEnv, @(
  "APP_DB_PASSWORD=$app",
  "KC_DB_PASSWORD=$kc",
  "KC_ADMIN_PASSWORD=$admin",
  'S3_ACCESS_KEY=socevidence',
  "S3_SECRET_KEY=$s3"
))

[IO.File]::WriteAllLines($backendEnv, @(
  'PORT=4000',
  "DATABASE_URL=postgres://soc:$app@localhost:15432/socportal",
  'OIDC_ISSUER=https://localhost:8443/realms/soc',
  'OIDC_JWKS_URL=http://localhost:8180/realms/soc/protocol/openid-connect/certs',
  'CORS_ORIGIN=https://localhost',
  "WEBHOOK_SECRET=$webhook",
  'MERGE_WINDOW_MINUTES=60',
  'SMTP_HOST=localhost',
  'SMTP_PORT=1025',
  'MAIL_FROM=soc-portal@soc.local',
  'WORKER_INTERVAL_SECONDS=10',
  'EVIDENCE_STORE=s3',
  'S3_ENDPOINT=http://localhost:9000',
  'S3_ACCESS_KEY=socevidence',
  "S3_SECRET_KEY=$s3",
  'S3_BUCKET=soc-evidence',
  "EVIDENCE_KEY=$evidence",
  'MAX_UPLOAD_MB=25',
  'AUDIT_VIEW_COALESCE_SECONDS=60',
  'RATE_LIMIT_PER_MINUTE=3000',
  'TRUST_PROXY=0'
))

Write-Host 'Created .env and backend\.env with random secrets (never commit them).'
Write-Host "Keycloak admin password is in .env (KC_ADMIN_PASSWORD). Back up backend\.env: losing EVIDENCE_KEY makes stored evidence unreadable."