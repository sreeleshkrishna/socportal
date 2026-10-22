// Imports the full MITRE ATT&CK Enterprise catalog from MITRE's public STIX file.
// Usage (from backend):  npx tsx scripts/import-attack.ts enterprise-attack.json
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../src/config.js';

interface StixObject {
  type: string;
  name?: string;
  revoked?: boolean;
  x_mitre_deprecated?: boolean;
  external_references?: Array<{ source_name: string; external_id?: string }>;
  kill_chain_phases?: Array<{ kill_chain_name: string; phase_name: string }>;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/import-attack.ts <enterprise-attack.json>');
  process.exit(1);
}

const tactic = (phase: string) =>
  phase.split('-').map((w) => (w === 'and' ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

const bundle = JSON.parse(await readFile(file, 'utf8')) as { objects: StixObject[] };
const rows: Array<{ id: string; name: string; tactics: string[] }> = [];
for (const o of bundle.objects) {
  if (o.type !== 'attack-pattern' || o.revoked || o.x_mitre_deprecated || !o.name) continue;
  const ref = o.external_references?.find(
    (r) => r.source_name === 'mitre-attack' && /^T\d{4}(\.\d{3})?$/.test(r.external_id ?? ''));
  if (!ref?.external_id) continue;
  const tactics = (o.kill_chain_phases ?? []).filter((p) => p.kill_chain_name === 'mitre-attack').map((p) => tactic(p.phase_name));
  rows.push({ id: ref.external_id, name: o.name, tactics });
}

const db = new pg.Pool({ connectionString: config.databaseUrl });
try {
  await db.query(
    `insert into attack_techniques (id, name, tactics)
     select x.id, x.name, array(select jsonb_array_elements_text(x.tactics))
     from jsonb_to_recordset($1::jsonb) as x(id text, name text, tactics jsonb)
     on conflict (id) do update set name = excluded.name, tactics = excluded.tactics`,
    [JSON.stringify(rows)]);
  console.log(`imported ${rows.length} techniques`);
} finally {
  await db.end();
}