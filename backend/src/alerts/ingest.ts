import { autoTag } from '../tagging/auto.js';
import { appendAudit } from '../audit/service.js';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { addEvent } from '../cases/events.js';
import type { Severity } from '../cases/service.js';
import { withTx } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { applyPlaybook } from '../playbooks/service.js';
import { upsertSla } from '../sla/service.js';
import type { NormalizedAlert } from './normalizers.js';
import { matchPlaybook } from './playbookMatch.js';

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export const fingerprintOf = (a: NormalizedAlert) =>
  createHash('sha256')
    .update([a.source, a.ruleId, a.host ?? '', a.srcIp ?? ''].join('|').toLowerCase())
    .digest('hex');

export interface IngestResult {
  result: 'created' | 'merged' | 'duplicate';
  caseId: string;
  caseNumber: string;
  processingMs: number;
}

export async function ingestAlert(db: Pool, a: NormalizedAlert, windowMinutes: number): Promise<IngestResult> {
  const started = performance.now();
  const fp = fingerprintOf(a);

  const out = await withTx(db, async (c) => {
    // Serialise alerts with the same fingerprint so they cannot create two cases
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [fp]);

    if (a.externalId) {
      const dup = await c.query(
        `select a.case_id, c.case_number from alerts a join cases c on c.id = a.case_id
         where a.source = $1 and a.external_id = $2`, [a.source, a.externalId]);
      if (dup.rowCount) {
        return { result: 'duplicate' as const, caseId: dup.rows[0].case_id as string, caseNumber: String(dup.rows[0].case_number) };
      }
    }

    const open = await c.query(
      `select id, case_number, severity from cases
       where fingerprint = $1 and status not in ('resolved', 'closed')
         and last_alert_at > now() - make_interval(mins => $2::int)
       order by last_alert_at desc limit 1 for update`, [fp, windowMinutes]);

    let caseId: string;
    let caseNumber: string;
    let result: 'created' | 'merged';

    if (open.rowCount) {
      const row = open.rows[0];
      caseId = row.id;
      caseNumber = String(row.case_number);
      result = 'merged';
      const bumped = RANK[a.severity] > RANK[row.severity as Severity];
      await c.query(
        `update cases set alert_count = alert_count + 1, last_alert_at = now(), updated_at = now(),
           severity = $2 where id = $1`, [caseId, bumped ? a.severity : row.severity]);
      if (bumped) await upsertSla(c, caseId); // higher severity, tighter deadlines
      await addEvent(c, caseId, null, 'alert_merged', {
        source: a.source, ruleId: a.ruleId, severity: a.severity, severityRaised: bumped,
      });
    } else {
      const title = `${a.ruleName}${a.host ? ` on ${a.host}` : ''}`.slice(0, 200);
      const r = await c.query(
        `insert into cases (title, description, severity, status, source, fingerprint, alert_count, last_alert_at)
         values ($1, $2, $3, 'new', $4, $5, 1, now()) returning id, case_number`,
        [title, a.summary, a.severity, a.source, fp]);
      caseId = r.rows[0].id;
      caseNumber = String(r.rows[0].case_number);
      result = 'created';
      await addEvent(c, caseId, null, 'case_created_from_alert', { source: a.source, ruleId: a.ruleId });
      await upsertSla(c, caseId);

      const key = matchPlaybook(a);
      if (key) {
        try {
          await applyPlaybook(c, caseId, key, null);
        } catch (e) {
          // a missing playbook must never stop an alert from becoming a case
          if (!(e instanceof HttpError && e.status === 404)) throw e;
        }
      }
    }

    await c.query(
      `insert into alerts (case_id, source, external_id, rule_id, rule_name, severity, host, src_ip,
                           fingerprint, raw_payload, event_time)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [caseId, a.source, a.externalId ?? null, a.ruleId, a.ruleName, a.severity,
       a.host ?? null, a.srcIp ?? null, fp, JSON.stringify(a.raw), a.eventTime ?? null]);
       await autoTag(c, caseId, { srcIp: a.srcIp, techniques: a.techniques });
       await appendAudit(c, {
      actorName: `siem:${a.source}`,
      action: result === 'created' ? 'alert.case_created' : 'alert.merged',
      entity: 'case',
      entityId: caseId,
      detail: {
        caseNumber, ruleId: a.ruleId, ruleName: a.ruleName, severity: a.severity,
        host: a.host ?? null, srcIp: a.srcIp ?? null,
      },
    });

    return { result, caseId, caseNumber };
  });

  return { ...out, processingMs: Math.round(performance.now() - started) };
}