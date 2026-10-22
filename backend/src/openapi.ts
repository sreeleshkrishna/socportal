import type { RouteDef } from './routes.js';

type Json = Record<string, any>;

const SEVERITY = { type: 'string', enum: ['low', 'medium', 'high', 'critical'] };
const STATUS = { type: 'string', enum: ['new', 'triage', 'in_progress', 'escalated', 'contained', 'resolved', 'closed'] };
const IOC_TYPE = { type: 'string', enum: ['ip', 'domain', 'url', 'email', 'md5', 'sha1', 'sha256'] };
const uuid = { type: 'string', format: 'uuid' };
const text = (max: number, min = 1): Json => ({ type: 'string', minLength: min, maxLength: max });
const obj = (properties: Json, required: string[] = []): Json =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const jsonBody = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
const query = (name: string, schema: Json, required = false) => ({ name, in: 'query', required, schema });

const BODIES: Record<string, Json> = {
  'case.create': obj({ title: text(200, 3), severity: SEVERITY, description: text(10000, 0), playbook: { type: 'string', example: 'phishing' } }, ['title', 'severity']),
  'case.update': obj({ title: text(200, 3), severity: SEVERITY, description: text(10000, 0) }),
  'case.assign': obj({ assigneeId: { ...uuid, nullable: true } }, ['assigneeId']),
  'case.transition': obj({ to: STATUS, reason: text(2000, 3), summary: text(10000, 3) }, ['to']),
  'case.escalate': obj({ reason: text(2000, 3) }, ['reason']),
  'case.close': obj({ reason: text(2000, 3) }),
  'case.note': obj({ body: text(10000) }, ['body']),
  'case.playbook': obj({ key: { type: 'string', enum: ['phishing', 'malware', 'brute-force', 'data-exfiltration'] } }, ['key']),
  'case.task_add': obj({ title: text(200, 3), description: text(5000, 0) }, ['title']),
  'case.task_update': obj({ status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'skipped'] }, assigneeId: { ...uuid, nullable: true } }),
  'ioc.add': obj({ value: text(2000), type: IOC_TYPE, note: text(500, 0) }, ['value']),
  'technique.add': obj({ id: { type: 'string', example: 'T1110.001' }, note: text(500, 0) }, ['id']),
};

const QUERIES: Record<string, Json[]> = {
  'case.list': [
    query('status', STATUS), query('severity', SEVERITY), query('assignee', uuid), query('q', text(100)),
    query('limit', { type: 'integer', minimum: 1, maximum: 200, default: 50 }),
    query('offset', { type: 'integer', minimum: 0, default: 0 }),
  ],
  'audit.view': [
    query('limit', { type: 'integer', minimum: 1, maximum: 500, default: 100 }),
    query('before', { type: 'integer', minimum: 1 }), query('action', text(100)),
    query('actor', text(200)), query('entity', text(50)), query('entityId', text(100)),
  ],
  'audit.verify': [query('anchor', { type: 'string', pattern: '^[0-9a-f]{64}$' })],
  'dashboard.view': [query('days', { type: 'integer', minimum: 1, maximum: 365, default: 30 })],
  'ioc.search': [query('q', text(200, 3), true), query('type', IOC_TYPE)],
  'technique.search': [query('q', text(100, 0))],
};

const PATH_PARAMS: Record<string, Json> = {
  version: { type: 'integer', minimum: 1 },
  techniqueId: { type: 'string', pattern: '^T[0-9]{4}(\\.[0-9]{3})?$' },
};

const CREATED = new Set(['case.create', 'case.note', 'case.task_add', 'evidence.upload', 'ioc.add', 'technique.add']);

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export function buildOpenApi(routes: readonly RouteDef[], serverUrl: string): Json {
  const paths: Record<string, Json> = {};
  const tags = new Set<string>();

  for (const r of routes) {
    const action = r.audit.action;
    const tag = action.split('.')[0];
    tags.add(tag);
    const pathParams = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: PATH_PARAMS[m[1]] ?? uuid,
    }));

    const success = CREATED.has(action) ? '201' : '200';
    const responses: Json = {
      [success]: { description: 'Success' },
      '400': errorResponse('Validation failed'),
      '401': errorResponse('Missing or invalid token'),
      '403': errorResponse('The caller\'s role does not allow this action'),
      '404': errorResponse('Not found'),
      '409': errorResponse('Conflict with the current state (for example an invalid status transition)'),
    };
    if (action === 'evidence.download') {
      responses[success] = { description: 'The decrypted file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    }
    if (action === 'report.export') {
      responses[success] = { description: 'PDF case report', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } };
    }

    const op: Json = {
      operationId: action.replace(/\./g, '_'),
      summary: action,
      tags: [tag],
      security: [{ bearerAuth: [] }],
      'x-required-permission': r.permission,
      parameters: [...pathParams, ...(QUERIES[action] ?? [])],
      responses,
    };
    if (BODIES[action]) op.requestBody = jsonBody(BODIES[action]);
    if (action === 'evidence.upload') {
      op.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: obj({
          file: { type: 'string', format: 'binary' }, name: text(200), description: text(2000, 0),
        }, ['file']) } },
      };
    }

    const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    (paths[p] ??= {})[r.method] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'SOC Case Management Portal API',
      version: '1.0.0',
      description: 'Every endpoint requires a Keycloak access token (Bearer). The role-to-permission mapping is in docs/rbac-matrix.md; the permission each operation needs is listed in x-required-permission.',
    },
    servers: [{ url: serverUrl }],
    tags: [...tags].map((name) => ({ name })),
    paths: {
      '/health': { get: { operationId: 'health', summary: 'Liveness and database check', responses: { '200': { description: 'ok' }, '503': { description: 'database unavailable' } } } },
      '/webhooks/alerts/{source}': {
        post: {
          operationId: 'alert_webhook', summary: 'SIEM alert ingestion (creates or merges a case)', tags: ['alert'],
          security: [{ webhookToken: [] }],
          parameters: [{ name: 'source', in: 'path', required: true, schema: { type: 'string', enum: ['wazuh', 'elastic', 'generic'] } }],
          requestBody: jsonBody({ type: 'object', description: 'Wazuh alert JSON, Elastic webhook body, or the generic format (id, rule_id, rule_name, severity, host, src_ip, timestamp)' }),
          responses: {
            '200': { description: 'Merged into an existing case, or a duplicate alert' },
            '201': { description: 'A new case was created' },
            '400': errorResponse('Malformed alert'), '401': errorResponse('Wrong webhook token'), '404': errorResponse('Unknown source'),
          },
        },
      },
      ...paths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        webhookToken: { type: 'apiKey', in: 'header', name: 'X-Webhook-Token' },
      },
      schemas: { Error: obj({ error: { type: 'string' }, message: { type: 'string' } }) },
    },
  };
}