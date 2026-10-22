import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { parse } from '../validation.js';
import { listAudit, verifyChain } from './service.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  action: z.string().max(100).optional(),
  actor: z.string().max(200).optional(),
  entity: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
});
const verifySchema = z.object({ anchor: z.string().regex(/^[0-9a-f]{64}$/).optional() });

export const list = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await listAudit(db, parse(listSchema, req.query)));
};

export const verify = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await verifyChain(db, parse(verifySchema, req.query).anchor));
};