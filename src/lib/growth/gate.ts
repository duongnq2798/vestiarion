import "server-only";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { platformDb } from "@/lib/dal";

/**
 * Who may see the founder dashboard and use its actions: a signed-in person on platform_team, asked of the database on
 * every call (growth_team_member, migration 0099). Anyone else gets null, and so does everyone while the function
 * cannot be read (before 0099 runs, say): the gate fails closed. The page answers null with notFound(), so it never
 * says it exists; each action and the export check again for themselves, since an action is a public POST endpoint.
 */
export async function growthTeamUser(): Promise<SessionUser | null> {
  const user = await getSessionUser();
  if (!user) return null;
  try {
    const { data, error } = await platformDb().rpc("growth_team_member", { p_user: user.id });
    if (error) {
      console.error("growth gate: growth_team_member not read", error.message);
      return null;
    }
    return data === true ? user : null;
  } catch (error) {
    console.error("growth gate: growth_team_member not read", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
