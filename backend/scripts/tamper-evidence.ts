// Dev tool for the tamper demo: flips one byte of a stored evidence object.
// Usage (from backend):  npx tsx scripts/tamper-evidence.ts <object_key>
import { config } from '../src/config.js';
import { createFsStore, createS3Store } from '../src/evidence/storage.js';

const key = process.argv[2];
if (!key) {
  console.error('usage: tsx scripts/tamper-evidence.ts <object_key>');
  process.exit(1);
}
const store = config.evidenceStore === 'fs' ? createFsStore() : createS3Store();
const data = await store.get(key);
data[0] ^= 0xff;
await store.put(key, data);
console.log(`flipped one byte of ${key}`);