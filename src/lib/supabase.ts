import type { SupabaseClient } from "@supabase/supabase-js";
import { currentContext } from "./context";

/**
 * The service-role Supabase client for whichever business the current work
 * belongs to. It bypasses row-level security, so it must never be imported
 * from a client component; browser roles have no table access at all, and
 * server-rendered dashboard reads go through here exclusively.
 *
 * This used to be a module-level cached client built from `process.env`, which
 * meant a process could only ever talk to one database: the first caller
 * decided, and every later one silently inherited that choice. The client now
 * comes from the scope the work is running in, so two configurations can run
 * concurrently without seeing each other. See `./context.ts`.
 *
 * The signature is unchanged on purpose — every existing call site keeps
 * working, and a single-tenant deployment still resolves its configuration
 * from the environment exactly as before.
 */
export function supabase(): SupabaseClient {
  return currentContext().db;
}

/** Throws with the Postgres error message attached, rather than a bare `null`. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data");
  return result.data;
}
