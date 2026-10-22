import type { PoolClient } from 'pg';
import { tryClassifyIoc } from './ioc.js';
import { attachIoc } from './service.js';

// Called inside the alert-ingest transaction: the source IP becomes an IOC and
// ATT&CK ids from the SIEM rule become techniques (ids missing from the catalog are skipped)
export async function autoTag(c: PoolClient, caseId: string, a: { srcIp?: string; techniques?: string[] }) {
  if (a.srcIp) {
    const ioc = tryClassifyIoc(a.srcIp);
    if (ioc?.type === 'ip') await attachIoc(c, caseId, ioc, 'siem', null);
  }
  for (const raw of new Set((a.techniques ?? []).map((t) => t.trim().toUpperCase()))) {
    if (!/^T\d{4}(\.\d{3})?$/.test(raw)) continue;
    await c.query(
      `insert into case_techniques (case_id, technique_id, source)
       select $1::uuid, id, 'siem' from attack_techniques where id = $2
       on conflict do nothing`, [caseId, raw]);
  }
}