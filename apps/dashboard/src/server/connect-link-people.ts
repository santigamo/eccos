/** Who a connection link speaks for: the admin who made it and their workspace. */
export interface LinkPeople {
  workspace: string;
  inviter: string;
  inviterEmail: string;
}

const MAY_CONNECT = new Set(["owner", "admin"]);

/**
 * Null once the creator is no longer an owner or admin of the workspace, so a
 * link stops working with the access that made it.
 */
export async function linkPeople(db: D1Database, organizationId: string, userId: string): Promise<LinkPeople | null> {
  const row = await db
    .prepare(
      `SELECT u."name" AS inviter, u."email" AS email, o."name" AS workspace, m."role" AS role
       FROM "member" m JOIN "user" u ON u."id" = m."userId" JOIN "organization" o ON o."id" = m."organizationId"
       WHERE m."organizationId" = ? AND m."userId" = ?`,
    )
    .bind(organizationId, userId)
    .first<{ inviter: string; email: string; workspace: string; role: string }>();
  if (!row || !row.role.split(",").some((role) => MAY_CONNECT.has(role.trim()))) return null;
  return { workspace: row.workspace, inviter: row.inviter.trim() || row.workspace, inviterEmail: row.email };
}
