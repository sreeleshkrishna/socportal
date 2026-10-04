export const ROLES = [
  'tier1_analyst', 'tier2_analyst', 'incident_responder', 'soc_manager', 'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'case:read' | 'case:create' | 'case:update' | 'case:assign'
  | 'case:escalate' | 'case:close' | 'audit:read' | 'user:read';

export const MATRIX: Record<Role, readonly Permission[]> = {
  tier1_analyst: ['case:read', 'case:create', 'case:update', 'case:escalate'],
  tier2_analyst: ['case:read', 'case:create', 'case:update', 'case:assign', 'case:escalate'],
  incident_responder: ['case:read', 'case:update', 'case:assign', 'case:close'],
  soc_manager: ['case:read', 'case:create', 'case:update', 'case:assign', 'case:escalate', 'case:close', 'audit:read', 'user:read'],
  auditor: ['case:read', 'audit:read'],
};

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

export const can = (roles: Role[], perm: Permission): boolean =>
  roles.some((r) => MATRIX[r].includes(perm));