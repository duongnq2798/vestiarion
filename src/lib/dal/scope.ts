import { currentContext, runWith, type VestiarionContext } from "../context";
import { parseMasterKeys, type MasterKey } from "../secrets";
import { unwrap } from "../supabase";
import { FOUNDING_ORG_ID, ORG_SECRET_COLUMNS, orgConfig, type OrgRow } from "./org-config";

/**
 * How work enters an organization. Every tenant read and write happens inside
 * one of these; outside them, `currentOrgId()` throws.
 *
 * The organization's row is read once per scope and its secrets decrypted into
 * a configuration of its own. Nested scopes are safe: the inner one replaces
 * every organization field, so nothing of the outer organization survives.
 */

/**
 * An unset master key is reported per secret by `orgConfig`, so reading keeps
 * working. A master key that is set but malformed throws: that is a broken
 * deployment, not a missing optional.
 */
function masterKeys(): MasterKey[] | null {
  const raw = process.env.VESTIARION_MASTER_KEYS;
  return raw && raw.trim() ? parseMasterKeys(raw) : null;
}

async function orgRowBy(column: "id" | "slug", value: string): Promise<OrgRow> {
  const result = await currentContext().db.from("orgs").select(ORG_SECRET_COLUMNS).eq(column, value).single<OrgRow>();
  if (result.error?.code === "PGRST116") throw new Error(`No organization with ${column} ${value}`);
  return unwrap(result);
}

function contextFor(org: OrgRow, userId: string | undefined): VestiarionContext {
  const base = currentContext();
  const { config, warnings } = orgConfig(base.config, org, masterKeys());
  return { config, db: base.db, orgId: org.id, userId, secretWarnings: warnings };
}

export async function orgContext(orgId: string, userId?: string): Promise<VestiarionContext> {
  return contextFor(await orgRowBy("id", orgId), userId);
}

export async function withOrg<T>(orgId: string, fn: () => Promise<T>, options: { userId?: string } = {}): Promise<T> {
  return runWith(await orgContext(orgId, options.userId), fn);
}

/** For operators and scripts, which name organizations by slug. */
export async function withOrgSlug<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return runWith(contextFor(await orgRowBy("slug", slug), undefined), fn);
}

/**
 * The founding organization, for the three places the spec binds to it: the
 * cron (§10.3), the v1 API until scoped keys exist (§4.5), and the public
 * landing page. Nothing else may use it as a default.
 */
export function withFoundingOrg<T>(fn: () => Promise<T>): Promise<T> {
  return withOrg(FOUNDING_ORG_ID, fn);
}

/** What `requireMembership` and a successful `authorizeMutation` return. */
export interface OrgAccess {
  user: { id: string };
  membership: { orgId: string };
}

export function inOrg<T>(access: OrgAccess, fn: () => Promise<T>): Promise<T> {
  return withOrg(access.membership.orgId, fn, { userId: access.user.id });
}
