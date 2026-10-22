import type { Pool, PoolClient } from 'pg';
import { addEvent } from '../cases/events.js';
import { HttpError } from '../errors.js';

export async function listPlaybooks(db: Pool) {
  const r = await db.query(
    `select p.key, p.name, p.description,
            (select count(*)::int from playbook_tasks t where t.playbook_id = p.id) as task_count
     from playbooks p order by p.name`,
  );
  return { playbooks: r.rows };
}

// Call inside a transaction, with the case row already locked
export async function applyPlaybook(c: PoolClient, caseId: string, key: string, actorId: string | null): Promise<number> {
  const pb = await c.query('select id from playbooks where key = $1', [key]);
  if (!pb.rowCount) throw new HttpError(404, 'unknown_playbook', `No playbook named ${key}`);
  const cur = await c.query('select playbook_id from cases where id = $1', [caseId]);
  if (cur.rows[0]?.playbook_id) throw new HttpError(409, 'playbook_already_applied', 'This case already has a playbook');
  const ins = await c.query(
    `insert into case_tasks (case_id, position, title, description)
     select $1::uuid, position, title, description from playbook_tasks
     where playbook_id = $2 order by position`,
    [caseId, pb.rows[0].id],
  );
  await c.query('update cases set playbook_id = $2, updated_at = now() where id = $1', [caseId, pb.rows[0].id]);
  await addEvent(c, caseId, actorId, 'playbook_applied', { key, tasks: ins.rowCount });
  return ins.rowCount ?? 0;
}