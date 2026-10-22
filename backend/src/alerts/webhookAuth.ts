import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const sha = (s: string) => createHash('sha256').update(s).digest();

export const webhookAuth = (secret: string): RequestHandler => (req, res, next) => {
  if (secret.length < 24) {
    res.status(503).json({ error: 'webhook_disabled' }); // refuse to run with a weak/missing secret
    return;
  }
  const given = String(req.headers['x-webhook-token'] ?? '');
  if (!timingSafeEqual(sha(given), sha(secret))) {
    res.status(401).json({ error: 'invalid_webhook_token' });
    return;
  }
  next();
};