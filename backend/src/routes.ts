import type { RequestHandler } from 'express';
import type { Permission } from './auth/permissions.js';
import type { Deps } from './deps.js';
import * as h from './cases/handlers.js';

export interface RouteDef {
  method: 'get' | 'post' | 'patch';
  path: string;
  permission: Permission;
  handler: (deps: Deps) => RequestHandler;
}

export const routes: RouteDef[] = [
  { method: 'get',   path: '/api/cases',                 permission: 'case:read',     handler: h.listCases },
  { method: 'post',  path: '/api/cases',                 permission: 'case:create',   handler: h.createCase },
  { method: 'get',   path: '/api/cases/:id',             permission: 'case:read',     handler: h.getCase },
  { method: 'patch', path: '/api/cases/:id',             permission: 'case:update',   handler: h.updateCase },
  { method: 'post',  path: '/api/cases/:id/assign',      permission: 'case:assign',   handler: h.assignCase },
  { method: 'post',  path: '/api/cases/:id/transition',  permission: 'case:update',   handler: h.transitionTo() },
  { method: 'post',  path: '/api/cases/:id/escalate',    permission: 'case:escalate', handler: h.transitionTo('escalated') },
  { method: 'post',  path: '/api/cases/:id/close',       permission: 'case:close',    handler: h.transitionTo('closed') },
  { method: 'post',  path: '/api/cases/:id/notes',       permission: 'case:update',   handler: h.addNote },
  { method: 'get',   path: '/api/users',                 permission: 'user:read',     handler: h.listUsers },
  // Placeholder until Week 6 (hash-chained audit log)
  { method: 'get',   path: '/api/audit',                 permission: 'audit:read',    handler: () => (_req, res) => { res.json({ entries: [] }); } },
];