import type { RequestHandler } from 'express';
import type { Pool } from 'pg';

export const syncUser = (db: Pool): RequestHandler => async (req, res, next) => {
  const u = req.user!;
  await db.query(
    `insert into users (id, username, email, roles) values ($1, $2, $3, $4)
     on conflict (id) do update set username = excluded.username, email = excluded.email, roles = excluded.roles`,
    [u.id, u.username, u.email ?? null, u.roles],
  );
  next();
};