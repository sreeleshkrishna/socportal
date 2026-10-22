import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { auditStandalone } from './service.js';

export interface RouteAudit {
  action: string;
  entity: string;
  param?: string;     // URL parameter holding the entity id (default "id")
  coalesce?: boolean; // views: at most one entry per user per entity per window
}

interface Resolved extends RouteAudit {
  pattern: string;
  entityId: string | null;
  caseId: string | null;
}

const pending = new Set<Promise<unknown>>();
export const flushAudit = async () => { await Promise.allSettled([...pending]); };

// Only short, non-sensitive request fields are kept (never reasons, summaries or note text)
const BODY_KEYS = ['to', 'severity', 'assigneeId', 'key', 'status', 'name', 'title'];

// Runs inside each route, before the permission check, so denied attempts are logged too
export function setRouteAudit(pattern: string, meta: RouteAudit): RequestHandler {
  return (req, res, next) => {
    const id = req.params[meta.param ?? 'id'];
    const caseId = req.params.id;
    const resolved: Resolved = {
      ...meta,
      pattern,
      entityId: id === undefined ? null : String(id),
      caseId: caseId === undefined ? null : String(caseId),
    };
    res.locals.audit = resolved;
    next();
  };
}

export function auditRequests(db: Pool, opts: { coalesceSeconds: number }): RequestHandler {
  const lastSeen = new Map<string, number>();
  const windowMs = opts.coalesceSeconds * 1000;

  return (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if ((db as unknown as { ended?: boolean }).ended) return; // pool already closed (test teardown)
      const meta = res.locals.audit as Resolved | undefined;
      const user = req.user;
      const now = Date.now();
      const status = res.statusCode;

      // Coalesce repeated views and repeated anonymous noise; writes are never coalesced
      if (windowMs > 0 && (meta?.coalesce || !user)) {
        const key = `${user?.id ?? req.ip}|${meta?.action ?? 'unmatched'}|${meta?.entityId ?? ''}|${status}`;
        const prev = lastSeen.get(key);
        if (prev !== undefined && now - prev < windowMs) return;
        lastSeen.set(key, now);
        if (lastSeen.size > 5000) {
          for (const [k, t] of lastSeen) if (now - t >= windowMs) lastSeen.delete(k);
        }
      }

      const detail: Record<string, unknown> = {
        method: req.method,
        path: meta?.pattern ?? req.originalUrl.split('?')[0],
        status,
        outcome: status < 400 ? 'ok' : status === 401 || status === 403 ? 'denied' : 'error',
        ms: now - started,
      };
      if (meta?.caseId && meta.entity !== 'case') detail.caseId = meta.caseId;
      if (req.method !== 'GET' && req.body && typeof req.body === 'object') {
        for (const k of BODY_KEYS) {
          const v = (req.body as Record<string, unknown>)[k];
          if (typeof v === 'string') detail[k] = v;
        }
      }

      const p: Promise<unknown> = auditStandalone(db, {
        actorId: user?.id ?? null,
        actorName: user ? user.username || user.id : 'anonymous',
        action: meta?.action ?? 'api.unmatched',
        entity: meta?.entity ?? null,
        entityId: meta?.entityId ?? null,
        ip: req.ip ?? null,
        detail,
      })
        .catch((e) => console.error('[audit] failed to record entry', e))
        .finally(() => pending.delete(p));
      pending.add(p);
    });
    next();
  };
}