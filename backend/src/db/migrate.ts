import pg from 'pg';
import { config } from '../config.js';
import { runMigrations } from './migrator.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
await runMigrations(pool);
await pool.end();