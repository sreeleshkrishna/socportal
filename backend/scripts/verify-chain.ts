// scripts/verify-chain.ts  -  verifies the audit chain of the database in DATABASE_URL
import 'dotenv/config';
import pg from 'pg';
import { verifyChain } from '../src/audit/service.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const result = await verifyChain(db, process.argv[2]);
console.log(JSON.stringify(result));
await db.end();
process.exit(result.valid ? 0 : 1);