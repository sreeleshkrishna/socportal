import 'dotenv/config';
import pg from 'pg';
import { runMigrations } from '../src/db/migrator.js';
import { makePool, TEST_DB_NAME } from './testDb.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query('select 1 from pg_database where datname = $1', [TEST_DB_NAME]);
  if (!exists.rowCount) await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const pool = makePool();
  await runMigrations(pool);
  await pool.end();
}