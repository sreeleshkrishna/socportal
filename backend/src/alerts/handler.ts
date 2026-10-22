import type { RequestHandler } from 'express';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { ingestAlert } from './ingest.js';
import { normalize, SOURCES, type Source } from './normalizers.js';

export const alertWebhook = ({ db, mergeWindowMinutes }: Deps): RequestHandler => async (req, res) => {
  const source = String(req.params.source) as Source;
  if (!SOURCES.includes(source)) throw new HttpError(404, 'unknown_source', `Use one of: ${SOURCES.join(', ')}`);
  const alert = normalize(source, req.body ?? {});
  const r = await ingestAlert(db, alert, mergeWindowMinutes);
  res.status(r.result === 'created' ? 201 : 200).json(r);
};