import pg from 'pg';
import { config } from './config.js';
import { deliverPending } from './notify/deliver.js';
import { runSlaTick } from './sla/tick.js';

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
let running = false;

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const events = await runSlaTick(db);
    const sent = await deliverPending(db);
    if (events || sent) console.log(`[worker] sla events: ${events}, notifications sent: ${sent}`);
  } catch (e) {
    console.error('[worker] tick failed', e);
  } finally {
    running = false;
  }
}

console.log(`[worker] started, checking every ${config.workerIntervalSeconds}s`);
void tick();
const timer = setInterval(() => void tick(), config.workerIntervalSeconds * 1000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { clearInterval(timer); void db.end().then(() => process.exit(0)); });
}