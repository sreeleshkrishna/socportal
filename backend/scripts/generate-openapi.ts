// scripts/generate-openapi.ts  -  writes docs/openapi.json
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildOpenApi } from '../src/openapi.js';
import { routes } from '../src/routes.js';

const out = path.resolve(process.cwd(), '..', 'docs', 'openapi.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(buildOpenApi(routes, 'http://localhost:4000'), null, 2) + '\n');
console.log(`wrote ${out}`);