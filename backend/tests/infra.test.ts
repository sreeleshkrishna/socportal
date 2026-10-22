import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrator.js';
import { defaultSenders, deliverPending, type Senders } from '../src/notify/deliver.js';
import { makePool } from './testDb.js';

const pool = makePool();

beforeEach(async () => {
  await pool.query('truncate notifications restart identity');
});
afterAll(() => pool.end());

describe('migrations', () => {
  it('are idempotent and recorded', async () => {
    await runMigrations(pool);
    await runMigrations(pool);
    const r = await pool.query('select name from schema_migrations order by name');
    expect(r.rows.map((x) => x.name)).toEqual(
      expect.arrayContaining(['001_init.sql', '002_alerts.sql', '003_sla.sql', '004_playbooks.sql']),
    );
  });
});

describe('slack delivery', () => {
  it('escapes markup characters before sending', async () => {
    await pool.query(
      `insert into notifications (kind, channel, recipient, subject, body)
       values ('t', 'slack', 'slack', 'a <b> & c', 'body <x>')`);
    const texts: string[] = [];
    const senders: Senders = { email: async () => {}, slack: async (t) => { texts.push(t); } };
    expect(await deliverPending(pool, senders)).toBe(1);
    expect(texts[0]).toBe('*a &lt;b&gt; &amp; c*\nbody &lt;x&gt;');
  });

  it('the default slack sender posts to the webhook and reports errors', async () => {
    const original = config.slackWebhookUrl;
    config.slackWebhookUrl = 'https://hooks.test/abc';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await defaultSenders.slack('hello');
      expect(fetchMock).toHaveBeenCalledWith('https://hooks.test/abc', expect.objectContaining({ method: 'POST' }));
      await expect(defaultSenders.slack('hello')).rejects.toThrow('slack responded 500');
    } finally {
      config.slackWebhookUrl = original;
      vi.unstubAllGlobals();
    }
  });
});