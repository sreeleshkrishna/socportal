import type { PoolClient } from 'pg';
import { config } from '../config.js';

const clean = (s: string) => s.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 200);

export async function enqueueCaseNotification(
  c: PoolClient,
  n: { caseId: string; assignedTo: string | null; kind: string; subject: string; body: string },
) {
  const subject = clean(n.subject);
  // the owner (if any) plus every SOC manager
  const recipients = await c.query(
    `select distinct email from users
     where email is not null and (id = $1 or 'soc_manager' = any(roles))`,
    [n.assignedTo],
  );
  for (const r of recipients.rows) {
    await c.query(
      `insert into notifications (case_id, kind, channel, recipient, subject, body)
       values ($1, $2, 'email', $3, $4, $5)`,
      [n.caseId, n.kind, r.email, subject, n.body],
    );
  }
  if (config.slackWebhookUrl) {
    await c.query(
      `insert into notifications (case_id, kind, channel, recipient, subject, body)
       values ($1, $2, 'slack', 'slack', $3, $4)`,
      [n.caseId, n.kind, subject, n.body],
    );
  }
}