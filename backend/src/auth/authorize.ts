import type { RequestHandler } from 'express';
import { can, type Permission } from './permissions.js';

export const requirePermission =
  (perm: Permission): RequestHandler =>
  (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!can(req.user.roles, perm)) {
      // Week 6: replace with a write to the hash-chained audit log
      console.warn(`DENY user=${req.user.username} perm=${perm} ${req.method} ${req.originalUrl}`);
      res.status(403).json({ error: 'forbidden', required: perm });
      return;
    }
    next();
  };