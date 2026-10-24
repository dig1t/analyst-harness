export interface AuthPolicy {
  allowedUserIds: string[];
  allowedRoleIds: string[];
  adminUserIds: string[];
  /** Open the bot to every member of the guild. Off by default: the bot can run shell commands. */
  allowEveryone: boolean;
}

export interface DiscordUser {
  id: string;
  name?: string;
  roles: string[];
}

export function isAdmin(user: DiscordUser, policy: AuthPolicy): boolean {
  return policy.adminUserIds.includes(user.id);
}

/**
 * Deny by default. A Discord bot that can make an agent run code on the server must only
 * answer people the operator listed explicitly (by user id or role id).
 */
export function isAuthorized(user: DiscordUser, policy: AuthPolicy): boolean {
  if (isAdmin(user, policy)) return true;
  if (policy.allowEveryone) return true;
  if (policy.allowedUserIds.includes(user.id)) return true;
  return user.roles.some((r) => policy.allowedRoleIds.includes(r));
}

export function parseIdList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,25}$/.test(s));
}
