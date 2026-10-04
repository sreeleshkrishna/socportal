import type { Pool } from 'pg';

export interface Deps {
  db: Pool;
  mergeWindowMinutes: number; // used in Week 4
}