import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/auth/permissions.js';
import { checkTransition, STATUSES, TRANSITIONS } from '../src/cases/stateMachine.js';

const full = { reason: 'because', summary: 'because' };

describe('state machine: every from -> to pair', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
      const label = !t ? 'rejected (409)' : t.systemOnly ? 'system only (403 for users)' : 'allowed';
      it(`${from} -> ${to} is ${label}`, () => {
        const r = checkTransition(from, to, ['soc_manager'], full);
        if (!t) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.status).toBe(409);
        } else if (t.systemOnly) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.status).toBe(403);
        } else {
          expect(r.ok).toBe(true);
        }
      });
    }
  }
});

describe('state machine rules', () => {
  it('closed is terminal', () => {
    expect(TRANSITIONS.some((t) => t.from === 'closed')).toBe(false);
  });
  it('auditor cannot perform any transition', () => {
    for (const t of TRANSITIONS) {
      const r = checkTransition(t.from, t.to, ['auditor'], full);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
    }
  });
  it('no role can use a system-only transition', () => {
    for (const t of TRANSITIONS.filter((x) => x.systemOnly)) {
      for (const role of ROLES) expect(checkTransition(t.from, t.to, [role], full).ok).toBe(false);
    }
  });
  it('tier 1 cannot close', () => {
    expect(checkTransition('resolved', 'closed', ['tier1_analyst'], {}).ok).toBe(false);
  });
  it('escalating needs a reason, resolving needs a summary', () => {
    const e = checkTransition('in_progress', 'escalated', ['tier1_analyst'], {});
    const s = checkTransition('contained', 'resolved', ['tier1_analyst'], {});
    expect(!e.ok && e.status).toBe(400);
    expect(!s.ok && s.status).toBe(400);
  });
});