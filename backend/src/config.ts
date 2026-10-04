import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  oidcIssuer: process.env.OIDC_ISSUER ?? 'http://localhost:8180/realms/soc',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
};