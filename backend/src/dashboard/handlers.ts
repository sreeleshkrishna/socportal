import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { parse } from '../validation.js';
import { getDashboard } from './service.js';

const schema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const dashboard = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await getDashboard(db, parse(schema, req.query).days));
};