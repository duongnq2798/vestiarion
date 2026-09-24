import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { configFromEnv, type VestiarionConfig } from "./config";

/**
 * The configured Vestiarion instance the current work belongs to.
 *
 * This replaces three module-level singletons — the Supabase client, the chain
 * provider and the Anthropic client — each of which quietly made the process
 * single-tenant. Whoever called first decided which business the whole process
 * served, and the second caller silently got the first one's database.
 *
 * Scoping rather than threading is a deliberate choice. Passing a context
 * argument through every function would be the purest design and would also
 * mean changing the signature of most of the library in one commit, on a
 * codebase that moves real money. `AsyncLocalStorage` gives the same property
 * — concurrent cycles for different businesses cannot see each other's clients
 * — while letting call sites migrate one at a time. It is Node's supported
 * mechanism for exactly this, and it survives `await` boundaries, which a
 * module variable does not.
 *
 * A process with no scope entered falls back to one derived from the
 * environment. That keeps the single-tenant Next.js app working untouched, and
 * it is why `runWith` is additive rather than a breaking change.
 */

export interface VestiarionContext {
  config: VestiarionConfig;
  /** Service-role client. Bypasses row-level security; never expose to a browser. */
  db: SupabaseClient;
}

const storage = new AsyncLocalStorage<VestiarionContext>();

/** The environment-derived context, built once, for the single-tenant case. */
let ambient: VestiarionContext | undefined;

function createDb(config: VestiarionConfig): SupabaseClient {
  return createClient(config.database.url, config.database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createContext(config: VestiarionConfig): VestiarionContext {
  return { config, db: createDb(config) };
}

/**
 * Runs `fn` against a specific configuration. Everything it calls — directly
 * or through any number of awaits — sees that context and no other.
 *
 * This is the whole multi-tenant story: an MCP server or a Slack bot resolves
 * which workspace a request belongs to, builds or looks up its context, and
 * runs the work inside it.
 */
export function runWith<T>(context: VestiarionContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Convenience for callers that have a config rather than a built context. */
export function runWithConfig<T>(config: VestiarionConfig, fn: () => T): T {
  return runWith(createContext(config), fn);
}

/**
 * The context the current work belongs to.
 *
 * Falling back to the environment is what keeps this additive. It is also the
 * only place the fallback is allowed to happen: a library that reads
 * `process.env` from deep inside its call graph cannot be configured by
 * anybody, which is the state this replaces.
 */
export function currentContext(): VestiarionContext {
  const scoped = storage.getStore();
  if (scoped) return scoped;
  ambient ??= createContext(configFromEnv());
  return ambient;
}

export function currentConfig(): VestiarionConfig {
  return currentContext().config;
}

/** True when work is running inside an explicit scope rather than the ambient one. */
export function hasScope(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Drops the environment-derived context so the next call rebuilds it. Tests
 * that change the environment need this; nothing in production should.
 */
export function resetAmbientContext(): void {
  ambient = undefined;
}
