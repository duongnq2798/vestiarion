import { unstable_cache } from "next/cache";

/**
 * How long a public figure read through `sharedRead` is served before the database is asked again. The landing and
 * /open read the same cross-workspace aggregates, and the production check opens both every 10 minutes: within this
 * window every instance and every page shares one read.
 */
export const SHARED_READ_SECONDS = 300;

/**
 * Reads a public, cross-workspace figure through Next's data cache, where one copy is shared by every instance of the
 * deployment (open numbers design R9). Within `SHARED_READ_SECONDS` of a read, the copy kept is served. Past that, it
 * is still served at once and the database is read again after the response: a slow aggregate, even one the database
 * stops at its statement timeout, never holds a visitor, and when that read fails the copy kept stays. Only a read
 * that succeeded is kept, so `read` throws for a failure rather than answering with an empty figure. The first read of
 * a key, with nothing kept yet, waits for the database as before.
 *
 * `key` names what is read and with what: everything `read` asks the database for must be in it, since the cache keys
 * on `key` and the source of `read`, never on the values `read` closes over. It is for pages and routes, where Next
 * has a cache; `npm run numbers` and tests read the database directly.
 */
export function sharedRead<T>(key: readonly string[], read: () => Promise<T>): Promise<T> {
  return unstable_cache(read, ["shared-read", ...key], { revalidate: SHARED_READ_SECONDS })();
}
