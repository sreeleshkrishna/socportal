import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { authenticate } from './auth/authenticate.js';
import { requirePermission } from './auth/authorize.js';
import { syncUser } from './auth/syncUser.js';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { routes } from './routes.js';

export interface AppDeps {
  getKey: JWTVerifyGetKey;
  issuer: string;
  corsOrigin: string;
  db: Pool;
  mergeWindowMinutes?: number;
}

export function createApp(d: AppDeps) {
  const deps: Deps = { db: d.db, mergeWindowMinutes: d.mergeWindowMinutes ?? 60 };
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: d.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/health', async (_req, res) => {
    try {
      await d.db.query('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  app.use('/api', authenticate(d.getKey, d.issuer));
  app.use('/api', syncUser(d.db));
  app.get('/api/me', (req, res) => { res.json(req.user); });

  for (const r of routes) {
    app.route(r.path)[r.method](requirePermission(r.permission), r.handler(deps));
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