import { unstable_cache } from "next/cache";

/**
 * The public figures' shared cache (docs/superpowers/specs/2026-11-19-public-figures-cache-design.md): what /open, the
 * landing and /studios read from production is kept in Next.js's data cache, which Vercel shares across a deployment's
 * instances, so a visitor seldom waits on a database connection that has gone cold (PF1).
 *
 * An entry is fresh for `PUBLIC_READ_SECONDS` (PF2). After that, the next read is answered from it at once and a new
 * one is read behind it, so the first visit after a quiet spell can show figures read before it; each page shows when
 * its figures were read. A read that throws is never kept (PF3): its caller gets the error, and an entry already held
 * stays until a read succeeds. Entries are kept per deployment (PF4), so a value never reaches code that expects
 * another shape; without Vercel's deployment id, the key holds the reader's own source, as Next.js's does by default.
 *
 * Outside Next.js (`npm run numbers`, the tests) there is no such cache, and each call reads the database itself.
 */

/** How long an entry answers without a new read behind it: the minute the pages' figures have always been kept for. */
export const PUBLIC_READ_SECONDS = 60;

/** Each cached reader's name, the first of its key's parts after the deployment's. */
export type PublicReadName = "open-numbers" | "latest-team-decision" | "recent-team-decisions" | "landing-team-journeys";

/**
 * `read`, answered from the shared cache. Its arguments are the entry's key and what it returns is stored, so both must
 * be JSON; a rolling period is passed by name, never by its start, so it is the same entry on every request.
 */
export function publicRead<A extends unknown[], T>(name: PublicReadName, read: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const cached = unstable_cache(read, ["public-figures", process.env.VERCEL_DEPLOYMENT_ID ?? "", name], { revalidate: PUBLIC_READ_SECONDS });
  // Next.js compiles NEXT_RUNTIME into its server bundles; a script or a test has none, and no cache to keep entries in.
  return (...args: A) => (process.env.NEXT_RUNTIME === "nodejs" ? cached(...args) : read(...args));
}
