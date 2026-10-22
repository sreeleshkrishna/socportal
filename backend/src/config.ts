import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  oidcIssuer: process.env.OIDC_ISSUER ?? 'https://localhost:8443/realms/soc',
  oidcJwksUrl: process.env.OIDC_JWKS_URL ?? '',
  corsOrigin: process.env.CORS_ORIGIN ?? 'https://localhost',
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  mergeWindowMinutes: Number(process.env.MERGE_WINDOW_MINUTES ?? 60),
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: Number(process.env.SMTP_PORT ?? 1025),
  mailFrom: process.env.MAIL_FROM ?? 'soc-portal@soc.local',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  workerIntervalSeconds: Number(process.env.WORKER_INTERVAL_SECONDS ?? 10),
  evidenceStore: process.env.EVIDENCE_STORE ?? 's3', // 's3' or 'fs'
  evidenceDir: process.env.EVIDENCE_DIR ?? './evidence-data',
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  s3AccessKey: process.env.S3_ACCESS_KEY ?? '',
  s3SecretKey: process.env.S3_SECRET_KEY ?? '',
  s3Bucket: process.env.S3_BUCKET ?? 'soc-evidence',
  evidenceKey: process.env.EVIDENCE_KEY ?? '',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 25),
  auditViewCoalesceSeconds: Number(process.env.AUDIT_VIEW_COALESCE_SECONDS ?? 60),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 3000),
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
};