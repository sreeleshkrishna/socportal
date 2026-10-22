import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { listPlaybooks as listPlaybooksSvc } from '../playbooks/service.js';
import { parse } from '../validation.js';
import * as svc from './service.js';
import { allowedFor, STATUSES, type Status } from './stateMachine.js';
import * as tasks from './tasks.js';

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const uuid = z.string().uuid();
const playbookKey = z.string().trim().min(2).max(50).regex(/^[a-z0-9-]+$/);

const fields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().max(10000),
  severity: z.enum(SEVERITIES),
};
const createSchema = z.object({
  title: fields.title, severity: fields.severity,
  description: fields.description.optional(), playbook: playbookKey.optional(),
});
const patchSchema = z.object(fields).partial().refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  assignee: uuid.optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const assignSchema = z.object({ assigneeId: uuid.nullable() });
const noteSchema = z.object({ body: z.string().trim().min(1).max(10000) });
const transitionSchema = z.object({
  to: z.enum(STATUSES).optional(),
  reason: z.string().trim().min(3).max(2000).optional(),
  summary: z.string().trim().min(3).max(10000).optional(),
});
const applyPlaybookSchema = z.object({ key: playbookKey });
const addTaskSchema = z.object({ title: fields.title, description: z.string().max(5000).optional() });
const taskPatchSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'skipped']).optional(),
  assigneeId: uuid.nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });

export const listCases = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.listCases(db, parse(listSchema, req.query)));
};

export const createCase = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.status(201).json(await svc.createCase(db, req.user!, parse(createSchema, req.body ?? {})));
};

export const getCase = ({ db }: Deps): RequestHandler => async (req, res) => {
  const c = await svc.getCase(db, parse(uuid, req.params.id));
  res.json({ ...c, allowedTransitions: allowedFor(c.status, req.user!.roles) });
};

export const updateCase = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.updateCase(db, req.user!, parse(uuid, req.params.id), parse(patchSchema, req.body ?? {})));
};

export const assignCase = ({ db }: Deps): RequestHandler => async (req, res) => {
  const { assigneeId } = parse(assignSchema, req.body ?? {});
  res.json(await svc.assignCase(db, req.user!, parse(uuid, req.params.id), assigneeId));
};

// transitionTo()           -> generic endpoint, "to" comes from the body
// transitionTo('escalated') -> shortcut endpoints (escalate / close)
export const transitionTo = (fixed?: Status) => ({ db }: Deps): RequestHandler => async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(transitionSchema, req.body ?? {});
  const to = fixed ?? body.to;
  if (!to) throw new HttpError(400, 'validation_failed', 'to: required');
  res.json(await svc.transitionCase(db, req.user!, id, to, { reason: body.reason, summary: body.summary }));
};

export const addNote = ({ db }: Deps): RequestHandler => async (req, res) => {
  const { body } = parse(noteSchema, req.body ?? {});
  res.status(201).json(await svc.addNote(db, req.user!, parse(uuid, req.params.id), body));
};

export const listUsers = ({ db }: Deps): RequestHandler => async (_req, res) => {
  res.json(await svc.listUsers(db));
};

export const listPlaybooks = ({ db }: Deps): RequestHandler => async (_req, res) => {
  res.json(await listPlaybooksSvc(db));
};

export const applyPlaybookToCase = ({ db }: Deps): RequestHandler => async (req, res) => {
  const { key } = parse(applyPlaybookSchema, req.body ?? {});
  res.json(await tasks.applyPlaybookToCase(db, req.user!, parse(uuid, req.params.id), key));
};

export const addTask = ({ db }: Deps): RequestHandler => async (req, res) => {
  const body = parse(addTaskSchema, req.body ?? {});
  res.status(201).json(await tasks.addTask(db, req.user!, parse(uuid, req.params.id), body));
};

export const updateTask = ({ db }: Deps): RequestHandler => async (req, res) => {
  const patch = parse(taskPatchSchema, req.body ?? {});
  res.json(await tasks.updateTask(db, req.user!, parse(uuid, req.params.id), parse(uuid, req.params.taskId), patch));
};