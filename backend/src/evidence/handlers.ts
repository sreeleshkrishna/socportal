import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { parse } from '../validation.js';
import * as svc from './service.js';

const uuid = z.string().uuid();
const versionNo = z.coerce.number().int().min(1).max(100000);
const uploadSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

function ctxOf(deps: Deps, req: Request): svc.EvidenceCtx {
  if (!deps.store || !deps.evidenceKey) {
    throw new HttpError(503, 'evidence_disabled', 'Evidence storage is not configured');
  }
  return { db: deps.db, store: deps.store, key: deps.evidenceKey, ip: req.ip ?? null };
}

function toHttpError(err: unknown): unknown {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new HttpError(413, 'file_too_large', 'File exceeds the upload limit');
    return new HttpError(400, 'upload_failed', err.message);
  }
  return err;
}

export const listEvidence = (deps: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.listEvidence(deps.db, parse(uuid, req.params.id)));
};

export const uploadEvidence = (deps: Deps): RequestHandler => {
  // the file is held in memory so it can be hashed and encrypted; the size limit bounds that
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 5, parts: 8 },
  }).single('file');

  const handle = async (req: Request, res: Response) => {
    const ctx = ctxOf(deps, req);
    const caseId = parse(uuid, req.params.id);
    if (!req.file) throw new HttpError(400, 'no_file', 'Send the file in a multipart field named "file"');
    if (req.file.size === 0) throw new HttpError(400, 'empty_file', 'Empty files cannot be stored as evidence');
    const meta = parse(uploadSchema, { ...req.body });
    res.status(201).json(await svc.uploadEvidence(ctx, req.user!, caseId, req.file, meta));
  };

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err) { next(toHttpError(err)); return; }
      void handle(req, res).catch(next);
    });
  };
};

export const downloadEvidence = (deps: Deps): RequestHandler => async (req, res) => {
  const f = await svc.downloadEvidence(
    ctxOf(deps, req), req.user!, parse(uuid, req.params.id), parse(uuid, req.params.evidenceId), parse(versionNo, req.params.version));
  // Always an attachment with a generic type: uploaded HTML or scripts are never rendered by the browser
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('X-Evidence-SHA256', f.sha256);
  res.send(f.plain);
};

export const verifyEvidence = (deps: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.verifyEvidence(
    ctxOf(deps, req), req.user!, parse(uuid, req.params.id), parse(uuid, req.params.evidenceId), parse(versionNo, req.params.version)));
};

export const custody = (deps: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.listCustody(deps.db, parse(uuid, req.params.id), parse(uuid, req.params.evidenceId)));
};