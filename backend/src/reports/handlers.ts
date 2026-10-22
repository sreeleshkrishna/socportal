import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { parse } from '../validation.js';
import { buildCaseReport } from './caseReport.js';

const uuid = z.string().uuid();

export const exportReport = ({ db }: Deps): RequestHandler => async (req, res) => {
  const r = await buildCaseReport(db, req.user!, parse(uuid, req.params.id), req.ip ?? null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('X-Report-SHA256', r.sha256);
  res.send(r.pdf);
};