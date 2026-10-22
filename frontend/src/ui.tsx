import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import type { Sla, SlaPart, SlaState } from './types';

/* ---------- icons ---------- */
const ICONS = {
  cases: 'M4 6h16M4 12h16M4 18h10',
  chart: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  logout: 'M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  check: 'M5 12l5 5 9-10',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/* ---------- time and size ---------- */
export function span(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
export const ago = (iso: string) => `${span((Date.now() - new Date(iso).getTime()) / 1000)} ago`;
export const clock = (iso?: string | null) =>
  iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '-';
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- hooks ---------- */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// re-renders the caller every `ms` so countdowns keep moving
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ---------- messages ---------- */
export interface Notice { kind: 'ok' | 'error'; text: string }
export type Notify = (kind: Notice['kind'], text: string) => void;

export function friendly(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Your session ended. Sign in again.';
    if (e.status === 403) return "You don't have permission to do that.";
    if (e.status === 413) return 'That file is too large. The limit is 25 MB.';
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (e.status >= 500) return 'The service is unavailable. Try again in a moment.';
    return e.message;
  }
  if (e instanceof TypeError) return "Can't reach the server. Check your connection.";
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function Toast({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`toast toast--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Dismiss message">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

/* ---------- labels ---------- */
const STATUS_LABEL: Record<string, string> = {
  new: 'New', triage: 'Triage', in_progress: 'In progress', escalated: 'Escalated',
  contained: 'Contained', resolved: 'Resolved', closed: 'Closed',
};
const ORDER = ['new', 'triage', 'in_progress', 'escalated', 'contained', 'resolved', 'closed'];
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

export const SeverityTag = ({ severity }: { severity: string }) => (
  <span className={`sev sev--${severity}`}>{severity}</span>
);
export const StatusPill = ({ status }: { status: string }) => (
  <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
);

export function StatusTrack({ status }: { status: string }) {
  const at = ORDER.indexOf(status);
  return (
    <ol className="track" aria-label={`Case status: ${statusLabel(status)}`}>
      {ORDER.map((s, i) => (
        <li key={s} className={`track__step${i < at ? ' is-done' : i === at ? ' is-current' : ''}`}
          aria-current={i === at ? 'step' : undefined}>
          <span className="track__dot" aria-hidden="true" />
          <span className="track__label">{statusLabel(s)}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- service levels ---------- */
// One line for the queue: the next deadline that still matters
export function SlaChip({ sla, createdAt }: { sla?: Sla | null; createdAt?: string }) {
  if (!sla) return <span className="muted">No deadline</span>;
  const target = !sla.respond.done_at
    ? { label: 'Respond', part: sla.respond }
    : !sla.resolve.done_at ? { label: 'Resolve', part: sla.resolve } : null;
  if (!target) {
    const missed = sla.overall === 'breached';
    return (
      <span className={`sla sla--${missed ? 'breached' : 'met'}`}>
        <span className="sla__text">{missed ? 'Deadline missed' : 'Deadline met'}</span>
      </span>
    );
  }
  const now = Date.now();
  const due = new Date(target.part.due).getTime();
  const start = createdAt ? new Date(createdAt).getTime() : due - 3_600_000;
  const left = (due - now) / 1000;
  const late = left < 0;
  const state: SlaState = late ? 'breached' : target.part.state;
  const fraction = Math.min(1, Math.max(0, (now - start) / Math.max(1, due - start)));
  return (
    <span className={`sla sla--${state}`} title={`${target.label} deadline: ${clock(target.part.due)}`}>
      <span className="sla__text">{target.label}: {late ? `${span(left)} overdue` : `${span(left)} left`}</span>
      <span className="sla__bar" aria-hidden="true"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
    </span>
  );
}

// A full meter for the case workspace
export function SlaMeter({ label, part, createdAt }: { label: string; part: SlaPart; createdAt: string }) {
  const now = Date.now();
  const due = new Date(part.due).getTime();
  const start = new Date(createdAt).getTime();
  const done = part.done_at ? new Date(part.done_at).getTime() : null;
  const late = done !== null ? done > due : now > due;
  const state: SlaState = done !== null ? (late ? 'breached' : 'met') : late ? 'breached' : part.state;
  const fraction = Math.min(1, Math.max(0, ((done ?? now) - start) / Math.max(1, due - start)));
  const text = done !== null
    ? late ? `Done ${span((done - due) / 1000)} late` : `Done with ${span((due - done) / 1000)} to spare`
    : late ? `${span((now - due) / 1000)} overdue` : `${span((due - now) / 1000)} left`;
  return (
    <div className={`meter meter--${state}`}>
      <div className="meter__row">
        <span className="meter__label">{label}</span>
        <span className="meter__text">{text}</span>
      </div>
      <div className="meter__bar" role="img" aria-label={`${label}: ${text}`}>
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <div className="meter__due">Due {clock(part.due)}</div>
    </div>
  );
}

/* ---------- small pieces ---------- */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button type="button" className="btn btn--quiet btn--small"
      onClick={() => { void navigator.clipboard.writeText(text); }}>
      <Icon name="copy" size={14} /> {label}
    </button>
  );
}