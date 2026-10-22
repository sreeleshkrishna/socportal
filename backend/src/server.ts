import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { config } from './config.js';
import { createApp } from './app.js';
import { parseKey } from './evidence/crypto.js';
import { createStore, ensureBucket } from './evidence/storage.js';

const db = new pg.Pool({ connectionString: config.databaseUrl });

// Inside Docker the API reaches Keycloak by its internal name, but tokens carry the public issuer
const jwksUrl = config.oidcJwksUrl || `${config.oidcIssuer}/protocol/openid-connect/certs`;
const getKey = createRemoteJWKSet(new URL(jwksUrl));

const evidenceKey = parseKey(config.evidenceKey) ?? undefined;
if (evidenceKey) {
  void ensureBucket();
} else {
  console.warn('[evidence] EVIDENCE_KEY is missing or not 64 hex characters; evidence endpoints are disabled');
}

const app = createApp({
  getKey,
  issuer: config.oidcIssuer,
  corsOrigin: config.corsOrigin,
  db,
  webhookSecret: config.webhookSecret,
  mergeWindowMinutes: config.mergeWindowMinutes,
  store: evidenceKey ? createStore() : undefined,
  evidenceKey,
  maxUploadBytes: config.maxUploadMb * 1024 * 1024,
  viewCoalesceSeconds: config.auditViewCoalesceSeconds,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
});

const server = app.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`));

// Clean shutdown so `docker compose stop` does not cut requests off
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => { void db.end().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}