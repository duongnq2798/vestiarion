/**
 * The platform's one Linear OAuth app, "Vestiarion", which any Linear workspace may authorize
 * (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1). Off unless all three variables are set: then the
 * Linear card, the Contractors controls and every Linear route are not there. The webhook's signing secret is one of
 * them: without it no change in Linear would be read until the sweeper's next run, so there is no Linear at all.
 */

export interface LinearSettings {
  clientId: string;
  clientSecret: string;
  /** The signing secret of the app's webhook, which Linear makes for every workspace that authorizes the app (LN11). */
  webhookSecret: string;
}

/** Linear's client ids are 32 hex characters; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

export function linearSettingsFromEnv(env: Record<string, string | undefined> = process.env): LinearSettings | null {
  const clientId = env.LINEAR_CLIENT_ID?.trim();
  const clientSecret = env.LINEAR_CLIENT_SECRET?.trim();
  const webhookSecret = env.LINEAR_WEBHOOK_SECRET?.trim();
  if (!clientId || !clientSecret || !webhookSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Linear is off: LINEAR_CLIENT_ID is not a Linear client id");
    return null;
  }
  return { clientId, clientSecret, webhookSecret };
}

/**
 * The one scope asked (LN2): `read`, which Linear always grants. Nothing in Linear is created, commented on or changed,
 * and no webhook is made through the API, which would need `admin`.
 */
export const LINEAR_SCOPES = ["read"] as const;
