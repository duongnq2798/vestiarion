import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DatabaseConfig } from "../config";
import { mintRequestToken } from "./request-token";

/**
 * The client an organization's scope uses for its own data. Every request
 * authenticates as `vestiarion_tenant` with a token naming the organization,
 * so row-level security confines it even if the DAL's own filters were wrong.
 *
 * A fresh token is minted per request (supabase-js calls `accessToken` for
 * each one), so no cycle, however long, outlives its token. There is no
 * fallback to the service role: a missing setting is a broken deployment and
 * says so (§8).
 */
export function tenantClient(
  database: DatabaseConfig,
  orgId: string,
  userId?: string,
  options: { fetch?: typeof fetch; mint?: typeof mintRequestToken } = {}
): SupabaseClient {
  if (!database.anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set, so no organization's data can be reached");
  const secret = database.requestTokenSecret;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set, so no request can be authorised for an organization");
  const mint = options.mint ?? mintRequestToken;
  return createClient(database.url, database.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => mint({ orgId, userId, secret }),
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}
