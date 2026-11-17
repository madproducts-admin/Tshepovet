/**
 * Who may do what in the buyer portal (docs/03 §3.1 roles). The API enforces it with the
 * @RequirePermission() guard; the web app reads the same table to hide what a role cannot use
 * (hiding is a courtesy, the API is the control).
 */
export const ROLES = ['owner', 'admin', 'compliance_officer', 'procurement', 'ap_clerk', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  compliance_officer: 'Compliance officer',
  procurement: 'Procurement',
  ap_clerk: 'Accounts payable',
  viewer: 'Viewer',
};

/** Roles that must use two-step verification (owners and administrators hold the keys). */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['owner', 'admin'];

export const PERMISSIONS = [
  'suppliers:read',
  'suppliers:write',
  'checks:run',
  'monitoring:manage',
  'modules:use',
  'wallet:read',
  'wallet:topup',
  'developers:manage',
  'team:read',
  'team:manage',
  'compliance:read',
  'compliance:manage',
  'audit:read',
  'settings:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  compliance_officer: ['suppliers:read', 'suppliers:write', 'checks:run', 'monitoring:manage', 'modules:use', 'wallet:read', 'team:read', 'compliance:read', 'compliance:manage', 'audit:read'],
  procurement: ['suppliers:read', 'suppliers:write', 'checks:run', 'monitoring:manage', 'modules:use', 'wallet:read', 'team:read'],
  ap_clerk: ['suppliers:read', 'monitoring:manage', 'wallet:read', 'wallet:topup', 'team:read'],
  viewer: ['suppliers:read', 'wallet:read', 'team:read'],
};

export function can(role: string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[role]?.includes(permission) ?? false;
}

/** Roles a user may assign: never above their own (only an owner makes owners). */
export function assignableRoles(actor: Role): Role[] {
  if (actor === 'owner') return [...ROLES];
  if (actor === 'admin') return ROLES.filter((r) => r !== 'owner');
  return [];
}
