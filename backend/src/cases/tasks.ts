import type { Pool } from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { can } from '../auth/permissions.js';
import { withTx } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { applyPlaybook } from '../playbooks/service.js';
import { addEvent } from './events.js';
import { assertOpen, lockCase } from './service.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'skipped';

export async function applyPlaybookToCase(db: Pool, actor: AuthUser, caseId: string, key: string) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const tasks = await applyPlaybook(c, caseId, key, actor.id);
    return { applied: key, tasks };
  });
}

export async function addTask(db: Pool, actor: AuthUser, caseId: string, input: { title: string; description?: string }) {
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const r = await c.query(
      `insert into case_tasks (case_id, position, title, description)
       select $1::uuid, coalesce(max(position), 0) + 1, $2::text, $3::text
       from case_tasks where case_id = $1::uuid returning *`,
      [caseId, input.title, input.description ?? ''],
    );
    await addEvent(c, caseId, actor.id, 'task_added', { taskId: r.rows[0].id, title: input.title });
    return r.rows[0];
  });
}

export async function updateTask(
  db: Pool, actor: AuthUser, caseId: string, taskId: string,
  patch: { status?: TaskStatus; assigneeId?: string | null },
) {
  if (patch.assigneeId !== undefined && !can(actor.roles, 'case:assign')) {
    throw new HttpError(403, 'forbidden', 'Assigning tasks requires case:assign');
  }
  return withTx(db, async (c) => {
    assertOpen(await lockCase(c, caseId));
    const cur = await c.query('select id from case_tasks where id = $1 and case_id = $2 for update', [taskId, caseId]);
    if (!cur.rowCount) throw new HttpError(404, 'task_not_found', 'Task not found');

    const params: unknown[] = [taskId];
    const sets: string[] = [];
    if (patch.status) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
      if (patch.status === 'done' || patch.status === 'skipped') {
        params.push(actor.id);
        sets.push(`completed_by = $${params.length}`, 'completed_at = now()');
      } else {
        sets.push('completed_by = null', 'completed_at = null');
      }
    }
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId) {
        const u = await c.query('select 1 from users where id = $1', [patch.assigneeId]);
        if (!u.rowCount) throw new HttpError(400, 'unknown_assignee', 'That user has never logged in');
      }
      params.push(patch.assigneeId);
      sets.push(`assignee_id = $${params.length}`);
    }
    const r = await c.query(`update case_tasks set ${sets.join(', ')} where id = $1 returning *`, params);
    await addEvent(c, caseId, actor.id, 'task_updated', { taskId, title: r.rows[0].title, ...patch });
    return r.rows[0];
  });
}