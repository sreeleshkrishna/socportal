import { z } from 'zod';
import type { Severity } from '../cases/service.js';
import { parse } from '../validation.js';

export type Source = 'wazuh' | 'elastic' | 'generic';
export const SOURCES: readonly Source[] = ['wazuh', 'elastic', 'generic'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export interface NormalizedAlert {
  techniques?: string[];
  source: Source;
  externalId?: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  host?: string;
  srcIp?: string;
  eventTime?: Date;
  summary: string;
  raw: unknown;
}

const clean = (s?: string) => { const v = s?.trim(); return v ? v.slice(0, 255) : undefined; };
const toDate = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/* ---------- Wazuh (levels 0-15) ---------- */
export const wazuhLevelToSeverity = (l: number): Severity =>
  l >= 12 ? 'critical' : l >= 10 ? 'high' : l >= 7 ? 'medium' : 'low';

const wazuhSchema = z.object({
  id: z.string().optional(),
  timestamp: z.string().optional(),
  rule: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    level: z.coerce.number().int().min(0).max(15),
    description: z.string().default('Wazuh alert'),
    mitre: z.object({ id: z.array(z.string()).optional() }).optional(),
  }),
  agent: z.object({ id: z.string().optional(), name: z.string().optional(), ip: z.string().optional() }).optional(),
  data: z.object({ srcip: z.string().optional(), srcuser: z.string().optional() }).passthrough().optional(),
  full_log: z.string().optional(),
}).passthrough();

function wazuh(body: unknown): NormalizedAlert {
  const a = parse(wazuhSchema, body);
  const mitre = a.rule.mitre?.id ?? [];
  return {
    source: 'wazuh',
    externalId: clean(a.id),
    ruleId: a.rule.id,
    ruleName: a.rule.description.slice(0, 200),
    severity: wazuhLevelToSeverity(a.rule.level),
    host: clean(a.agent?.name),
    srcIp: clean(a.data?.srcip),
    eventTime: toDate(a.timestamp),
    techniques: mitre,
    summary: [
      `Wazuh rule ${a.rule.id} (level ${a.rule.level})`,
      a.agent?.name && `Agent: ${a.agent.name}`,
      a.data?.srcip && `Source IP: ${a.data.srcip}`,
      mitre.length > 0 && `MITRE: ${mitre.join(', ')}`,
      a.full_log && `Log: ${a.full_log.slice(0, 500)}`,
    ].filter(Boolean).join('\n'),
    raw: body,
  };
}

/* ---------- Elastic Security (custom webhook body, see 4.10) ---------- */
const elasticSchema = z.object({
  alert_id: z.string().optional(),
  rule: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    severity: z.string().optional(),
    risk_score: z.coerce.number().optional(),
  }),
  host: z.object({ name: z.string().optional() }).optional(),
  source: z.object({ ip: z.string().optional() }).optional(),
  '@timestamp': z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

function elasticSeverity(sev?: string, risk?: number): Severity {
  const s = sev?.toLowerCase();
  if (s && (SEVERITIES as readonly string[]).includes(s)) return s as Severity;
  if (risk === undefined) return 'medium';
  return risk >= 74 ? 'critical' : risk >= 48 ? 'high' : risk >= 22 ? 'medium' : 'low';
}

function elastic(body: unknown): NormalizedAlert {
  const a = parse(elasticSchema, body);
  return {
    source: 'elastic',
    externalId: clean(a.alert_id),
    ruleId: a.rule.id ?? a.rule.name,
    ruleName: a.rule.name.slice(0, 200),
    severity: elasticSeverity(a.rule.severity, a.rule.risk_score),
    host: clean(a.host?.name),
    srcIp: clean(a.source?.ip),
    eventTime: toDate(a['@timestamp']),
    summary: [`Elastic rule: ${a.rule.name}`, a.reason && `Reason: ${a.reason}`].filter(Boolean).join('\n'),
    raw: body,
  };
}

/* ---------- Generic (any tool, scripts, tests) ---------- */
const genericSchema = z.object({
  id: z.string().optional(),
  rule_id: z.string().min(1),
  rule_name: z.string().min(1),
  severity: z.enum(SEVERITIES),
  host: z.string().optional(),
  src_ip: z.string().optional(),
  timestamp: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

function generic(body: unknown): NormalizedAlert {
  const a = parse(genericSchema, body);
  return {
    source: 'generic',
    externalId: clean(a.id),
    ruleId: a.rule_id,
    ruleName: a.rule_name.slice(0, 200),
    severity: a.severity,
    host: clean(a.host),
    srcIp: clean(a.src_ip),
    eventTime: toDate(a.timestamp),
    summary: a.description ?? a.rule_name,
    raw: body,
  };
}

export function normalize(source: Source, body: unknown): NormalizedAlert {
  switch (source) {
    case 'wazuh': return wazuh(body);
    case 'elastic': return elastic(body);
    default: return generic(body);
  }
}