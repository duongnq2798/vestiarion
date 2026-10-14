/**
 * The platform's one Asana app, "Vestiarion", distributed to any workspace
 * (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1). Off unless both variables are set: then the Asana
 * card, the Contractors controls and every Asana route are not there, as HubSpot's.
 */

export interface AsanaSettings {
  clientId: string;
  clientSecret: string;
}

/** Asana's client ids are numeric gids; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

export function asanaSettingsFromEnv(env: Record<string, string | undefined> = process.env): AsanaSettings | null {
  const clientId = env.ASANA_CLIENT_ID?.trim();
  const clientSecret = env.ASANA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Asana is off: ASANA_CLIENT_ID is not an Asana client id");
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * The scopes registered for the app, exactly: Asana's authorize page refuses a scope the app was not registered for
 * (`forbidden_scopes`), and a new authorization is not added to an earlier one, so every one is asked each time. Read
 * only, but for the webhooks Vestiarion makes on the tasks it reads, and deletes.
 */
export const ASANA_SCOPES = [
  "workspaces:read",
  "projects:read",
  "tasks:read",
  "attachments:read",
  "stories:read",
  "users:read",
  "webhooks:read",
  "webhooks:write",
  "webhooks:delete",
] as const;
