import type { Pool } from 'pg';
import type { ObjectStore } from './evidence/storage.js';

export interface Deps {
  db: Pool;
  mergeWindowMinutes: number;
  store?: ObjectStore;
  evidenceKey?: Buffer;
  maxUploadBytes: number;
}