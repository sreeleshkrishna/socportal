import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { config } from './config.js';
import { createApp } from './app.js';

const db = new pg.Pool({ connectionString: config.databaseUrl });
const getKey = createRemoteJWKSet(new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`));

const app = createApp({ getKey, issuer: config.oidcIssuer, corsOrigin: config.corsOrigin, db });
app.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`));