import type { RequestHandler } from 'express';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isRole, type Role } from './permissions.js';

export interface AuthUser {
  id: string;
  username: string;
  email?: string;
  roles: Role[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(getKey: JWTVerifyGetKey, issuer: string): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), getKey, { issuer });
      const realmRoles = (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
      req.user = {
        id: payload.sub as string,
        username: (payload.preferred_username as string | undefined) ?? '',
        email: payload.email as string | undefined,
        roles: realmRoles.filter(isRole),
      };
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}