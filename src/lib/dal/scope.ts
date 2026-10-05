import { currentContext, runWith, type VestiarionContext } from "../context";
import type { VestiarionConfig } from "../config";
import { parseMasterKeys, type MasterKey } from "../secrets";
import { platformDb, unwrap } from "./index";
import { FOUNDING_ORG_ID, ORG_SECRET_COLUMNS, orgConfig, type OrgRow } from "./org-config";
import { tenantClient } from "./tenant-client";

/**
 * How work enters an organization. Every tenant read and write happens inside
 * one of these; outside them, `currentOrgId()` throws.
 *
 * The organization's row is read once per scope and its secrets decrypted into
 * a configuration of its own. Nested scopes are safe: each one is built from
 * the platform configuration carried in `platformConfig`, not from whatever
 * organization happens to be in scope already, so entering a second
 * organization from inside the first neither inherits nor leaks the first
 * organization's secrets or settings.
 */

/**
 * Either the parsed master keys, the reason none are usable, or `null` when
 * none are configured at all — `orgConfig` turns that reason into a warning
 * per stored secret rather than losing the whole scope to it. A master key
 * that is set but malformed is a broken deployment, not a missing optional,
 * but §5.4/§8 still call for reading to continue and for signing or paying to
 * be what fails, so this reports rather than throws.
 */
function masterKeys(): MasterKey[] | { unavailable: string } | null {
  const raw = process.env.VESTIARION_MASTER_KEYS;
  if (!raw || !raw.trim()) return null;
  try {
    return parseMasterKeys(raw);
  } catch (error) {
    return { unavailable: (error as Error).message };
  }
}

async function orgRowBy(column: "id" | "slug", value: string): Promise<OrgRow> {
  const result = await platformDb().from("orgs").select(ORG_SECRET_COLUMNS).eq(column, value).single<OrgRow>();
  if (result.error?.code === "PGRST116") throw new Error(`No organization with ${column} ${value}`);
  return unwrap(result);
}

/** The platform base a scope's own configuration is built from — see `contextFor`. */
function platformConfigOf(current: VestiarionContext): VestiarionConfig {
  return current.platformConfig ?? current.config;
}

/**
 * `tenantClient` refuses to build without these, naming the same two
 * settings — but by then `contextFor` has already read the organization's
 * row and decrypted its secrets for nothing. Checking here first, before
 * either happens, is what makes a broken deployment fail fast instead of
 * doing that work and throwing anyway.
 */
function requireDatabaseSettings(platformConfig: VestiarionConfig): void {
  if (!platformConfig.database.anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set, so no organization's data can be reached");
  }
  if (!platformConfig.database.requestTokenSecret) {
    throw new Error("SUPABASE_JWT_SECRET is not set, so no request can be authorised for an organization");
  }
}

/**
 * The same check, for a caller about to create an organization: finding out
 * only on the way into it would leave one behind that nobody can enter.
 */
export function requireOrgScopeSettings(): void {
  requireDatabaseSettings(platformConfigOf(currentContext()));
}

function contextFor(platformConfig: VestiarionConfig, org: OrgRow, userId: string | undefined): VestiarionContext {
  const current = currentContext();
  const { config, warnings } = orgConfig(platformConfig, org, masterKeys());
  return {
    config,
    db: current.db,
    // Database settings are platform settings, so the tenant client is built
    // from the platform's, never from anything the organization's row supplies.
    tenantDb: tenantClient(platformConfig.database, org.id, userId, { fetch: current.fetch }),
    fetch: current.fetch,
    orgId: org.id,
    userId,
    secretWarnings: warnings,
    platformConfig,
  };
}

export async function orgContext(orgId: string, userId?: string): Promise<VestiarionContext> {
  // Build from the platform base, not from whatever organization is already in
  // scope: entering org B from inside org A must not make B's config a
  // derivative of A's, so a nested `withOrg` still starts from the platform's
  // own settings (§ R7).
  const platformConfig = platformConfigOf(currentContext());
  requireDatabaseSettings(platformConfig);
  return contextFor(platformConfig, await orgRowBy("id", orgId), userId);
}

export async function withOrg<T>(orgId: string, fn: () => Promise<T>, options: { userId?: string } = {}): Promise<T> {
  return runWith(await orgContext(orgId, options.userId), fn);
}

/** For operators and scripts, which name organizations by slug. */
export async function withOrgSlug<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const platformConfig = platformConfigOf(currentContext());
  requireDatabaseSettings(platformConfig);
  return runWith(contextFor(platformConfig, await orgRowBy("slug", slug), undefined), fn);
}

/**
 * The founding organization, for the places the spec binds to it: the public
 * landing page and the demo reset. The cron used to be one (§10.3), before
 * step 5 of the rollout moved it to `runLiveOrganizations` over every `live`
 * organization (§4.4); the v1 API was another (§4.5), until workspace API keys
 * made each request serve its key's own workspace. Nothing else may use this
 * as a default.
 */
export function withFoundingOrg<T>(fn: () => Promise<T>): Promise<T> {
  return withOrg(FOUNDING_ORG_ID, fn);
}

/** What `requireMembership` and a successful `authorize` return. */
export interface OrgAccess {
  user: { id: string };
  membership: { orgId: string };
}

export function inOrg<T>(access: OrgAccess, fn: () => Promise<T>): Promise<T> {
  return withOrg(access.membership.orgId, fn, { userId: access.user.id });
}
