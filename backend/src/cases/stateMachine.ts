import { can, type Permission, type Role } from '../auth/permissions.js';

export const STATUSES = [
  'new', 'triage', 'in_progress', 'escalated', 'contained', 'resolved', 'closed',
] as const;
export type Status = (typeof STATUSES)[number];

type Field = 'reason' | 'summary';

export interface Transition {
  from: Status;
  to: Status;
  permission: Permission;
  requires?: Field;
}

// Anything not listed here is rejected with 409.
export const TRANSITIONS: readonly Transition[] = [
  { from: 'new',         to: 'triage',      permission: 'case:update' },
  { from: 'triage',      to: 'in_progress', permission: 'case:update' },
  { from: 'triage',      to: 'closed',      permission: 'case:close',    requires: 'reason' }, // false positive
  { from: 'in_progress', to: 'escalated',   permission: 'case:escalate', requires: 'reason' },
  { from: 'in_progress', to: 'contained',   permission: 'case:update' },
  { from: 'escalated',   to: 'in_progress', permission: 'case:update' },                       // de-escalate
  { from: 'escalated',   to: 'contained',   permission: 'case:update' },
  { from: 'contained',   to: 'resolved',    permission: 'case:update',   requires: 'summary' },
  { from: 'contained',   to: 'in_progress', permission: 'case:update',   requires: 'reason' }, // containment failed
  { from: 'resolved',    to: 'closed',      permission: 'case:close' },
  { from: 'resolved',    to: 'in_progress', permission: 'case:update',   requires: 'reason' }, // reopen
];

export type TransitionCheck =
  | { ok: true; transition: Transition }
  | { ok: false; status: 400 | 403 | 409; code: string; message: string };

export function checkTransition(
  from: Status, to: Status, roles: Role[], input: { reason?: string; summary?: string },
): TransitionCheck {
  const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
  if (!t) {
    return { ok: false, status: 409, code: 'invalid_transition', message: `Cannot move a case from ${from} to ${to}` };
  }
  if (!can(roles, t.permission)) {
    return { ok: false, status: 403, code: 'forbidden', message: `Requires ${t.permission}` };
  }
  if (t.requires && !input[t.requires]?.trim()) {
    return { ok: false, status: 400, code: 'missing_field', message: `${t.requires} is required for ${from} -> ${to}` };
  }
  return { ok: true, transition: t };
}

// Used by the UI to show only the buttons this user may press
export function allowedFor(from: Status, roles: Role[]) {
  return TRANSITIONS.filter((t) => t.from === from && can(roles, t.permission))
    .map((t) => ({ to: t.to, requires: t.requires ?? null }));
}