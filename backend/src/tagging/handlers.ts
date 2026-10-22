import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { parse } from '../validation.js';
import { IOC_TYPES } from './ioc.js';
import * as svc from './service.js';

const uuid = z.string().uuid();
const iocSchema = z.object({
  value: z.string().min(1).max(2000),
  type: z.enum(IOC_TYPES).optional(),
  note: z.string().max(500).optional(),
});
const techniqueSchema = z.object({ id: z.string().trim().min(5).max(9), note: z.string().max(500).optional() });
const techniqueParam = z.string().trim().min(5).max(9);
const iocSearchSchema = z.object({ q: z.string().trim().min(3).max(200), type: z.enum(IOC_TYPES).optional() });
const techniqueSearchSchema = z.object({ q: z.string().trim().max(100).default('') });

export const listIocs = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.listCaseIocs(db, parse(uuid, req.params.id)));
};
export const addIoc = ({ db }: Deps): RequestHandler => async (req, res) => {
  const body = parse(iocSchema, req.body ?? {});
  res.status(201).json(await svc.addIoc(db, req.user!, parse(uuid, req.params.id), body, req.ip ?? null));
};
export const removeIoc = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.removeIoc(db, req.user!, parse(uuid, req.params.id), parse(uuid, req.params.iocId), req.ip ?? null));
};
export const searchIocs = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.searchIocs(db, parse(iocSearchSchema, req.query)));
};

export const listTechniques = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.listCaseTechniques(db, parse(uuid, req.params.id)));
};
export const addTechnique = ({ db }: Deps): RequestHandler => async (req, res) => {
  const body = parse(techniqueSchema, req.body ?? {});
  res.status(201).json(await svc.addTechnique(db, req.user!, parse(uuid, req.params.id), body, req.ip ?? null));
};
export const removeTechnique = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.removeTechnique(db, req.user!, parse(uuid, req.params.id), parse(techniqueParam, req.params.techniqueId), req.ip ?? null));
};
export const searchTechniques = ({ db }: Deps): RequestHandler => async (req, res) => {
  res.json(await svc.searchTechniques(db, parse(techniqueSearchSchema, req.query).q));
};