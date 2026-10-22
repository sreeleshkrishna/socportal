import request from 'supertest';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { bearer, getKey, ISSUER, USERS } from './helpers.js';

const brokenPool = {
  query: async () => { throw new Error('database is down'); },
} as unknown as Pool;
const app = createApp({ getKey, issuer: ISSUER, corsOrigin: 'http://localhost:5173', db: brokenPool });

afterEach(() => vi.restoreAllMocks());

describe('error handling', () => {
  it('health reports 503 when the database is down', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'db_unavailable' });
  });

  it('malformed JSON returns 400', async () => {
    const res = await request(app)
      .post('/api/cases')
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('unexpected errors return 500 without leaking details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/me').set('Authorization', await bearer(['auditor'], USERS.aud));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });
});