import { isIP } from 'node:net';
import { HttpError } from '../errors.js';

export const IOC_TYPES = ['ip', 'domain', 'url', 'email', 'md5', 'sha1', 'sha256'] as const;
export type IocType = (typeof IOC_TYPES)[number];
export interface Ioc { type: IocType; value: string }

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,63}$/;

// Analysts often paste "defanged" indicators from reports: hxxps://evil[.]com
export function refang(raw: string): string {
  return raw
    .trim()
    .replace(/^["'<]+|["'>]+$/g, '')
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[:\]/g, ':')
    .replace(/\[@\]|\[at\]/gi, '@');
}

export function tryClassifyIoc(raw: string): Ioc | null {
  if (typeof raw !== 'string') return null;
  const v = refang(raw);
  if (!v || v.length > 2000 || /[\u0000-\u001f\u007f\s]/.test(v)) return null;
  const lower = v.toLowerCase();

  if (/^[a-f0-9]{64}$/.test(lower)) return { type: 'sha256', value: lower };
  if (/^[a-f0-9]{40}$/.test(lower)) return { type: 'sha1', value: lower };
  if (/^[a-f0-9]{32}$/.test(lower)) return { type: 'md5', value: lower };

  const ipKind = isIP(v);
  if (ipKind) return { type: 'ip', value: ipKind === 6 ? lower : v };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!['http:', 'https:', 'ftp:'].includes(u.protocol) || !u.hostname) return null;
      return { type: 'url', value: u.toString() };
    } catch {
      return null;
    }
  }

  if (v.includes('@')) return EMAIL_RE.test(lower) ? { type: 'email', value: lower } : null;

  const domain = lower.replace(/\.$/, '');
  return DOMAIN_RE.test(domain) ? { type: 'domain', value: domain } : null;
}

export function classifyIoc(value: string, expected?: IocType): Ioc {
  const ioc = tryClassifyIoc(value);
  if (!ioc) throw new HttpError(400, 'invalid_ioc', 'Not a valid IP address, domain, URL, email address or file hash');
  if (expected && expected !== ioc.type) {
    throw new HttpError(400, 'ioc_type_mismatch', `This value looks like a ${ioc.type}, not a ${expected}`);
  }
  return ioc;
}