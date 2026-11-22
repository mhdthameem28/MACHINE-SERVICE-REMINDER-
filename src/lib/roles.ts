export type UserRole = 'admin' | 'store_keeper' | 'operator' | 'viewer';

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  store_keeper: 'Store Keeper',
  operator: 'Production Operator',
  viewer: 'Viewer / Manager',
};

export const ALL_ROLES: UserRole[] = ['admin', 'store_keeper', 'operator', 'viewer'];

export function canAccessReports(role: UserRole): boolean {
  return role === 'admin' || role === 'store_keeper' || role === 'viewer';
}

export function canReceiveOrAdjustStock(role: UserRole): boolean {
  return role === 'admin' || role === 'store_keeper';
}

export function canAdvanceBatch(role: UserRole): boolean {
  return role === 'admin' || role === 'operator';
}

export function canManageSettings(role: UserRole): boolean {
  return role === 'admin';
}
