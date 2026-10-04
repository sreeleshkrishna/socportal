import 'dotenv/config';
import pg from 'pg';

export const TEST_DB_NAME = 'socportal_test';

export function testDbUrl() {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${TEST_DB_NAME}`;
  return u.toString();
}

export const makePool = () => new pg.Pool({ connectionString: testDbUrl(), max: 20 });