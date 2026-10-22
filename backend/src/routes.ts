import type { RequestHandler } from 'express';
import * as audit from './audit/handlers.js';
import type { RouteAudit } from './audit/middleware.js';
import type { Permission } from './auth/permissions.js';
import * as h from './cases/handlers.js';
import * as dash from './dashboard/handlers.js';
import type { Deps } from './deps.js';
import * as ev from './evidence/handlers.js';
import * as report from './reports/handlers.js';
import * as tag from './tagging/handlers.js';

export interface RouteDef {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  permission: Permission;
  audit: RouteAudit;
  handler: (deps: Deps) => RequestHandler;
}

const onCase = (action: string, coalesce = false): RouteAudit => ({ action, entity: 'case', coalesce });
const onEvidence = (action: string): RouteAudit => ({ action, entity: 'evidence', param: 'evidenceId' });

export const routes: RouteDef[] = [
  { method: 'get',   path: '/api/cases',                    permission: 'case:read',     audit: onCase('case.list', true),  handler: h.listCases },
  { method: 'post',  path: '/api/cases',                    permission: 'case:create',   audit: onCase('case.create'),      handler: h.createCase },
  { method: 'get',   path: '/api/cases/:id',                permission: 'case:read',     audit: onCase('case.view', true),  handler: h.getCase },
  { method: 'patch', path: '/api/cases/:id',                permission: 'case:update',   audit: onCase('case.update'),      handler: h.updateCase },
  { method: 'post',  path: '/api/cases/:id/assign',         permission: 'case:assign',   audit: onCase('case.assign'),      handler: h.assignCase },
  { method: 'post',  path: '/api/cases/:id/transition',     permission: 'case:update',   audit: onCase('case.transition'),  handler: h.transitionTo() },
  { method: 'post',  path: '/api/cases/:id/escalate',       permission: 'case:escalate', audit: onCase('case.escalate'),    handler: h.transitionTo('escalated') },
  { method: 'post',  path: '/api/cases/:id/close',          permission: 'case:close',    audit: onCase('case.close'),       handler: h.transitionTo('closed') },
  { method: 'post',  path: '/api/cases/:id/notes',          permission: 'case:update',   audit: onCase('case.note'),        handler: h.addNote },
  { method: 'post',  path: '/api/cases/:id/playbook',       permission: 'case:update',   audit: onCase('case.playbook'),    handler: h.applyPlaybookToCase },
  { method: 'post',  path: '/api/cases/:id/tasks',          permission: 'case:update',   audit: onCase('case.task_add'),    handler: h.addTask },
  { method: 'patch', path: '/api/cases/:id/tasks/:taskId',  permission: 'case:update',   audit: onCase('case.task_update'), handler: h.updateTask },
  { method: 'get',   path: '/api/playbooks',                permission: 'case:read',     audit: { action: 'playbook.list', entity: 'playbook', coalesce: true }, handler: h.listPlaybooks },
  { method: 'get',   path: '/api/users',                    permission: 'user:read',     audit: { action: 'user.list', entity: 'user' }, handler: h.listUsers },

  { method: 'get',   path: '/api/cases/:id/evidence',       permission: 'case:read',     audit: onCase('evidence.list', true), handler: ev.listEvidence },
  { method: 'post',  path: '/api/cases/:id/evidence',       permission: 'case:update',   audit: onCase('evidence.upload'),     handler: ev.uploadEvidence },
  { method: 'get',   path: '/api/cases/:id/evidence/:evidenceId/versions/:version/download', permission: 'case:read', audit: onEvidence('evidence.download'), handler: ev.downloadEvidence },
  { method: 'post',  path: '/api/cases/:id/evidence/:evidenceId/versions/:version/verify',   permission: 'case:read', audit: onEvidence('evidence.verify'),   handler: ev.verifyEvidence },
  { method: 'get',   path: '/api/cases/:id/evidence/:evidenceId/custody',                    permission: 'case:read', audit: onEvidence('evidence.custody'),  handler: ev.custody },

  { method: 'get',    path: '/api/cases/:id/iocs',                    permission: 'case:read',   audit: onCase('ioc.list', true), handler: tag.listIocs },
  { method: 'post',   path: '/api/cases/:id/iocs',                    permission: 'case:update', audit: onCase('ioc.add'),        handler: tag.addIoc },
  { method: 'delete', path: '/api/cases/:id/iocs/:iocId',             permission: 'case:update', audit: onCase('ioc.remove'),     handler: tag.removeIoc },
  { method: 'get',    path: '/api/cases/:id/techniques',              permission: 'case:read',   audit: onCase('technique.list', true), handler: tag.listTechniques },
  { method: 'post',   path: '/api/cases/:id/techniques',              permission: 'case:update', audit: onCase('technique.add'),  handler: tag.addTechnique },
  { method: 'delete', path: '/api/cases/:id/techniques/:techniqueId', permission: 'case:update', audit: onCase('technique.remove'), handler: tag.removeTechnique },
  { method: 'get',    path: '/api/attack/techniques',                 permission: 'case:read',   audit: { action: 'technique.search', entity: 'technique', coalesce: true }, handler: tag.searchTechniques },
  { method: 'get',    path: '/api/search/iocs',                       permission: 'case:read',   audit: { action: 'ioc.search', entity: 'ioc' }, handler: tag.searchIocs },

  { method: 'get',   path: '/api/cases/:id/report',         permission: 'case:read',     audit: onCase('report.export'),    handler: report.exportReport },
  { method: 'get',   path: '/api/dashboard',                permission: 'dashboard:read', audit: { action: 'dashboard.view', entity: 'dashboard', coalesce: true }, handler: dash.dashboard },

  { method: 'get',   path: '/api/audit',                    permission: 'audit:read',    audit: { action: 'audit.view', entity: 'audit' },   handler: audit.list },
  { method: 'get',   path: '/api/audit/verify',             permission: 'audit:read',    audit: { action: 'audit.verify', entity: 'audit' }, handler: audit.verify },
];