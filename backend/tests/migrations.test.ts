import 'dotenv/config';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrator.js';

const FRESH = 'socportal_migrations_test';

describe('migrations', () => {
  it('apply cleanly to an empty database', async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${FRESH}`);
    await admin.query(`create database ${FRESH}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${FRESH}`;
    const fresh = new pg.Pool({ connectionString: url.toString() });
    try {
      await runMigrations(fresh);
      const t = await fresh.query(`select table_name from information_schema.tables where table_schema = 'public'`);
      expect(t.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(['users', 'cases', 'alerts', 'case_sla', 'notifications', 'playbooks', 'case_tasks']),
      );
    } finally {
      await fresh.end();
      await admin.query(`drop database if exists ${FRESH}`);
      await admin.end();
    }
  });
});