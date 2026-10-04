import type { Pool, PoolClient } from 'pg';

export async function addEvent(
  c: Pool | PoolClient, caseId: string, actorId: string | null, type: string, detail: object = {},
) {
  await c.query(
    'insert into case_events (case_id, actor_id, type, detail) values ($1, $2, $3, $4)',
    [caseId, actorId, type, JSON.stringify(detail)],
  );
}