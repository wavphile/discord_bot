export type AuthorizationPolicy = Readonly<{
  guildId: string;
  allowedUserIds: ReadonlySet<string>;
  allowedRoleIds: ReadonlySet<string>;
}>;

export type AuthorizationRequest = Readonly<{
  guildId: string | null;
  userId: string;
  roleIds: Iterable<string>;
}>;

export type AuthorizationDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason: "guild_only" | "wrong_guild" | "not_allowlisted";
    }>;

export function authorizeInteraction(
  request: AuthorizationRequest,
  policy: AuthorizationPolicy,
): AuthorizationDecision {
  if (request.guildId === null) {
    return { allowed: false, reason: "guild_only" };
  }

  if (request.guildId !== policy.guildId) {
    return { allowed: false, reason: "wrong_guild" };
  }

  if (policy.allowedUserIds.has(request.userId)) {
    return { allowed: true };
  }

  for (const roleId of request.roleIds) {
    if (policy.allowedRoleIds.has(roleId)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: "not_allowlisted" };
}
