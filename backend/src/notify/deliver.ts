import nodemailer, { type Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { withTx } from '../db/tx.js';

export interface Senders {
  email(to: string, subject: string, text: string): Promise<void>;
  slack(text: string): Promise<void>;
}

let transport: Transporter | undefined;

export const defaultSenders: Senders = {
  async email(to, subject, text) {
    transport ??= nodemailer.createTransport({
      host: config.smtpHost, port: config.smtpPort, secure: false, ignoreTLS: true,
      connectionTimeout: 5000, socketTimeout: 10000,
    });
    await transport.sendMail({ from: config.mailFrom, to, subject, text });
  },
  async slack(text) {
    const res = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`slack responded ${res.status}`);
  },
};

const MAX_ATTEMPTS = 5;
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Sends pending notifications; failures are retried on later ticks, then marked failed
export async function deliverPending(db: Pool, senders: Senders = defaultSenders, batch = 50): Promise<number> {
  return withTx(db, async (c) => {
    const rows = await c.query(
      `select id, channel, recipient, subject, body, attempts from notifications
       where status = 'pending' order by id limit $1 for update skip locked`,
      [batch],
    );
    let sent = 0;
    for (const n of rows.rows) {
      try {
        if (n.channel === 'email') await senders.email(n.recipient, n.subject, n.body);
        else await senders.slack(escapeSlack(`*${n.subject}*\n${n.body}`));
        await c.query(
          `update notifications set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1`,
          [n.id],
        );
        sent++;
      } catch (e) {
        const attempts = (n.attempts as number) + 1;
        await c.query(
          `update notifications set attempts = $2, last_error = $3, status = $4 where id = $1`,
          [n.id, attempts, String((e as Error).message).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'],
        );
      }
    }
    return sent;
  });
}