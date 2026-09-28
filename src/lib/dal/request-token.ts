import crypto from "node:crypto";

/**
 * The token every tenant request carries (spec §5.6, Line 2 as built).
 *
 * PostgREST verifies it with the project's JWT secret, switches to the role it
 * names, and puts its claims in `request.jwt.claims`, where every row-level
 * policy reads `org_id` through `public.request_org_id()`.
 *
 * This is the only module that knows the algorithm and the secret. Moving to
 * an imported asymmetric key, together with Supabase's newer API keys, is a
 * change to this file and one environment variable.
 */

export const TENANT_ROLE = "vestiarion_tenant";
export const REQUEST_TOKEN_TTL_SECONDS = 300;

export interface RequestTokenInput {
  orgId: string;
  /** The signed-in person; absent for the cron and scripts, which act as the system. */
  userId?: string;
  secret: string;
  now?: number;
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function mintRequestToken({ orgId, userId, secret, now = Date.now() }: RequestTokenInput): string {
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set, so no request can be authorised for an organization");
  if (!orgId) throw new Error("A request token must name an organization");
  const iat = Math.floor(now / 1000);
  const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    role: TENANT_ROLE,
    aud: "authenticated",
    iss: "vestiarion",
    sub: userId ?? "system",
    org_id: orgId,
    iat,
    exp: iat + REQUEST_TOKEN_TTL_SECONDS,
  })}`;
  return `${signed}.${crypto.createHmac("sha256", secret).update(signed).digest("base64url")}`;
}
