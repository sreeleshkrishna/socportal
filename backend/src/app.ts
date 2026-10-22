import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { alertWebhook } from './alerts/handler.js';
import { webhookAuth } from './alerts/webhookAuth.js';
import { auditRequests, setRouteAudit } from './audit/middleware.js';
import { authenticate } from './auth/authenticate.js';
import { requirePermission } from './auth/authorize.js';
import { syncUser } from './auth/syncUser.js';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import type { ObjectStore } from './evidence/storage.js';
import { buildOpenApi } from './openapi.js';
import { routes } from './routes.js';

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

export interface AppDeps {
  getKey: JWTVerifyGetKey;
  issuer: string;
  corsOrigin: string;
  db: Pool;
  webhookSecret?: string;
  mergeWindowMinutes?: number;
  store?: ObjectStore;
  evidenceKey?: Buffer;
  maxUploadBytes?: number;
  viewCoalesceSeconds?: number;
  rateLimitPerMinute?: number;
  trustProxy?: number;
}

export function createApp(d: AppDeps) {
  const deps: Deps = {
    db: d.db,
    mergeWindowMinutes: d.mergeWindowMinutes ?? 60,
    store: d.store,
    evidenceKey: d.evidenceKey,
    maxUploadBytes: d.maxUploadBytes ?? 25 * 1024 * 1024,
  };
  const app = express();

  // Behind the gateway, trust exactly one proxy hop so req.ip is the real client
  app.set('trust proxy', d.trustProxy ?? 0);

  // HSTS is sent by the TLS gateway, not by the API
  app.use(helmet({ hsts: false }));
  app.use(cors({ origin: d.corsOrigin, exposedHeaders: ['Content-Disposition', 'X-Evidence-SHA256', 'X-Report-SHA256'] }));

  // Machine-to-machine webhook: shared-secret auth, own rate limit, no JWT.
  // Its audit entry is written inside the ingest transaction.
  app.post(
    '/webhooks/alerts/:source',
    rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }),
    webhookAuth(d.webhookSecret ?? ''),
    express.json({ limit: '1mb' }),
    alertWebhook(deps),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({
    windowMs: 60_000, limit: d.rateLimitPerMinute ?? 3000, standardHeaders: 'draft-8', legacyHeaders: false,
  }));

  app.get('/health', async (_req, res) => {
    try {
      await d.db.query('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  // Generated API documentation (not exposed through the public gateway)
  app.get('/openapi.json', (req, res) => {
    const host = req.get('host') ?? '';
    res.json(buildOpenApi(routes, `${req.protocol}://${HOST_RE.test(host) ? host : 'localhost:4000'}`));
  });

  // Nothing under /api may be cached by browsers or proxies (cases, evidence, reports)
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Everything under /api is audited, including denied and unauthenticated requests
  app.use('/api', auditRequests(d.db, { coalesceSeconds: d.viewCoalesceSeconds ?? 60 }));
  app.use('/api', authenticate(d.getKey, d.issuer));
  app.use('/api', syncUser(d.db));
  app.get('/api/me', setRouteAudit('/api/me', { action: 'user.me', entity: 'user', coalesce: true }), (req, res) => {
    res.json(req.user);
  });

  for (const r of routes) {
    app.route(r.path)[r.method](setRouteAudit(r.path, r.audit), requirePermission(r.permission), r.handler(deps));
  }

  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'bad_request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}