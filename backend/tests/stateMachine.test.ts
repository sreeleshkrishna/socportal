import { describe, expect, it } from 'vitest';
import { checkTransition, STATUSES, TRANSITIONS } from '../src/cases/stateMachine.js';

const full = { reason: 'because', summary: 'because' };

describe('state machine: every from -> to pair', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const defined = TRANSITIONS.some((t) => t.from === from && t.to === to);
      it(`${from} -> ${to} is ${defined ? 'allowed' : 'rejected'}`, () => {
        const r = checkTransition(from, to, ['soc_manager'], full);
        expect(r.ok).toBe(defined);
        if (!r.ok) expect(r.status).toBe(409);
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
  it('tier 1 cannot close', () => {
    const r = checkTransition('resolved', 'closed', ['tier1_analyst'], {});
    expect(r.ok).toBe(false);
  });
  it('escalating needs a reason, resolving needs a summary', () => {
    const e = checkTransition('in_progress', 'escalated', ['tier1_analyst'], {});
    const s = checkTransition('contained', 'resolved', ['tier1_analyst'], {});
    expect(!e.ok && e.status).toBe(400);
    expect(!s.ok && s.status).toBe(400);
  });
});