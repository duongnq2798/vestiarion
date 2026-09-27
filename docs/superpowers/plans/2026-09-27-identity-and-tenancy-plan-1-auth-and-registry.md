# Identity and Tenancy — Plan 1: Auth and Registry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared `AGENT_API_TOKEN` login with real accounts, put today's data inside a founding organization at `/o/founding/…`, and store that organization's secrets encrypted in the database — with nothing lost from the existing ledger.

**Architecture:** Supabase Auth (magic link, optional Google) through `@supabase/ssr` cookies; `src/proxy.ts` does optimistic redirects only and the real session check is `getUser()` in a small Data Access Layer under `src/lib/auth/`. Migration `0015` adds `orgs`, `memberships`, `invitations` and an `org_id` on every tenant table, backfilled to one founding organization. Product routes move under `src/app/o/[slug]/`. Until Plan 3, only an `owner` can change anything.

**Tech Stack:** Next.js 16.3.6 (App Router, `proxy.ts`), React 19, `@supabase/supabase-js` 2.117, `@supabase/ssr` 0.12.7, Zod 4, Vitest 5, PGlite 0.5.8 for real-Postgres tests, Node `crypto` (AES-256-GCM, Ed25519).

**Spec:** `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` — this plan implements rollout steps 1 and 2 (§10). Plan 2 (steps 3–4: the DAL and RLS) and Plan 3 (step 5: self-serve and roles) are written after this one ships, against the code it produces.

## Global Constraints

- Next.js 16: the request hook is `src/proxy.ts` exporting `proxy`, not `middleware`. It performs optimistic checks only; authoritative checks use `supabase.auth.getUser()` server-side (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`).
- `@supabase/ssr` is pinned to exactly `0.12.7`. Its `cookies.setAll` receives `(cookiesToSet, headers)`.
- Founding organization: id `00000000-0000-4000-8000-000000000001`, slug `founding`, name `Vestiarion workspace`, mode `live`.
- The founding ledger key id is `9b03458d9a617871`. `org:adopt-env` refuses any other key.
- `npm run db:migrate` re-runs **every** migration file on every invocation. Every migration must be idempotent.
- Tenant tables (11): `accounts`, `counterparties`, `invoices`, `milestones`, `treasury_actions`, `compliance_checks`, `forecasts`, `ledger_entries`, `payment_intents`, `cycle_runs`, `cycle_snapshots`. `sim_clock` is untouched in this plan.
- **Transitional:** in this plan every tenant `org_id` column defaults to the founding organization, so code that does not yet know about organizations keeps writing correct rows. Plan 2 removes the default. No new code may rely on it.
- **Transitional:** `LEDGER_SIGNING_KEY`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` stay in env and the app keeps reading them through this whole plan. `org:adopt-env` only copies them into the database; removing them from env is Plan 2's job, after reads switch over.
- Not a member of `/o/[slug]` → `notFound()` (404). Never 403 for organization existence.
- Until Plan 3, every mutating control requires role `owner`.
- The ledger never stores an email address. Human entries carry `detail.by = <user id>`.
- `cycle_snapshots` rejects `UPDATE` and `DELETE` by trigger. Never backfill with `UPDATE`.
- Tests that need Postgres use PGlite through `tests/support/pglite.ts`. No test talks to Supabase.
- `npm run verify` (lockfile check, typecheck, lint, tests) must pass at the end of every task.
- Write any file containing backslashes (regexes, escaped PEMs) with an editor, not an inline shell heredoc — the harness strips one level of backslash from inline commands.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Merging a pull request requires the human partner's explicit instruction for that pull request.

## Review Focus

1. **Open redirect through `?next=`** — `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:…` must all land on `/onboarding`, never off-site. *(Task 4, `safeNext` tests.)*
2. **Magic link opened in another browser or device** — the PKCE verifier cookie is missing, the code exchange fails, and the person must see "open the link in the browser you requested it from", not a stack trace. *(Task 5, `loginErrorMessage` test and callback redirect.)*
3. **`npm run db:migrate` run again after `0015`** — no error, no second founding organization, no row counts changed. *(Task 3, idempotency test.)*
4. **A malformed or differently-cased slug in the URL** — `/o/Founding/console`, `/o/a b/console` must be a 404 before any database query, not a crash or a match. *(Task 6, `isValidSlug` tests; `membershipFor` returns `null` early.)*
5. **Old bookmarks with query strings** — `/audit?domain=treasury` must arrive at `/o/founding/audit?domain=treasury`. *(Task 6, `legacyRedirects` test; Next.js preserves the query string on `redirects()` by default.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/secrets.ts` | Master-key parsing; AES-256-GCM envelope encrypt/decrypt with org+column AAD |
| `supabase/migrations/0015_tenancy.sql` | `orgs`, `memberships`, `invitations`; `org_id` on tenant tables; founding org |
| `tests/support/pglite.ts` | One place that builds a Supabase-shaped Postgres and applies migrations |
| `src/lib/auth/env.ts` | Reads the two public Supabase auth settings |
| `src/lib/auth/routes.ts` | Pure: which paths need a session, `safeNext` |
| `src/lib/auth/supabase-server.ts` | Cookie-bound Supabase client for server components, actions, route handlers |
| `src/lib/auth/session.ts` | `getSessionUser()`, `verifySession()` — the authoritative check |
| `src/proxy.ts` | Session refresh + optimistic redirect to `/login` |
| `src/lib/auth/messages.ts` | Pure: login error codes → sentences |
| `src/app/login/{page.tsx,actions.ts}`, `src/components/auth/LoginForm.tsx` | Sign-in UI and server actions |
| `src/app/auth/callback/route.ts` | Code exchange after the magic link / OAuth |
| `src/lib/auth/org-paths.ts` | Pure: slug validation, `orgHref`, legacy redirects (no imports, so `next.config.ts` can use it) |
| `src/lib/auth/roles.ts` | Pure: role list, `isOrgRole`, `canMutate` |
| `src/lib/auth/membership.ts` | `membershipsOf`, `membershipFor` (service role; organizations are platform data) |
| `src/lib/auth/authorize.ts` | `authorizeMutation`, `viewerCanMutate` for actions and pages |
| `src/lib/auth/revalidate.ts` | `revalidateOrgPages()` |
| `src/app/o/[slug]/layout.tsx` | Session + membership gate for every product page |
| `src/app/onboarding/page.tsx` | Where a signed-in person without a workspace lands |
| `src/lib/platform/adopt.ts` | Pure: encrypt env secrets for an org, refusing the wrong ledger key |
| `scripts/org-grant.ts`, `scripts/org-adopt-env.ts` | Operator commands |

---

### Task 1: Spike — does this Supabase project accept a server-signed JWT?

Decides spec §5.6 Option A or B. Nothing from this task is committed except the recorded decision.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` (§5.6)
- Create outside the repo: `<scratch dir>/jwt-acceptance.mjs` (throwaway)

**Interfaces:**
- Consumes: `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, optionally `SUPABASE_JWT_SECRET`)
- Produces: a written decision, A or B, that Plan 2 builds on

- [ ] **Step 1: Ask the human partner for the legacy JWT secret, if one exists**

In the Supabase dashboard: *Project Settings → JWT Keys*. If a **Legacy JWT secret** is shown, the partner adds it to `.env.local` as `SUPABASE_JWT_SECRET=<value>`. If none is shown, skip the secret — the probe below still reports the JWKS algorithms and the decision is Option B.

- [ ] **Step 2: Write the probe**

Create `jwt-acceptance.mjs` in a scratch directory (not the repo):

```js
// THROWAWAY spike. Run from the repo root: node <scratch>/jwt-acceptance.mjs
import { createRequire } from "node:module";
import crypto from "node:crypto";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
require("dotenv").config({ path: [".env.local"], quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secret = process.env.SUPABASE_JWT_SECRET;

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(payload, key) {
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(payload);
  const sig = crypto.createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const jwks = await fetch(`${url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: anon } });
const jwksBody = await jwks.json().catch(() => null);
console.log("JWKS:", jwks.status, "| algs:", (jwksBody?.keys ?? []).map((k) => k.alg).join(",") || "(none)");

if (!secret) {
  console.log("SUPABASE_JWT_SECRET not set: Option A cannot be tested. Decision: Option B.");
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const claims = {
  role: "authenticated",
  aud: "authenticated",
  sub: crypto.randomUUID(),
  org_id: "00000000-0000-4000-8000-000000000001",
  iat: now,
  exp: now + 300,
};

async function probe(label, token) {
  const res = await fetch(`${url}/rest/v1/ledger_entries?select=seq&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let code = "";
  try { code = JSON.parse(text).code ?? ""; } catch {}
  console.log(`${label}: HTTP ${res.status} | code ${code || "-"} | ${text.slice(0, 160)}`);
}

await probe("control   (wrong signature)", sign(claims, "definitely-not-the-project-secret"));
await probe("candidate (project secret) ", sign(claims, secret));
```

- [ ] **Step 3: Run it**

Run: `node <scratch>/jwt-acceptance.mjs`

Interpret:

| control | candidate | Decision |
|---|---|---|
| a JWT error (`PGRST301`, "JWSError", "invalid signature") | `42501` permission denied, or HTTP 200 | **Option A**: the signature was accepted and the request ran as `authenticated` (its table grants are revoked by `0003`, hence 42501) |
| a JWT error | a JWT error | **Option B** |
| anything else | anything | Stop. Report both lines verbatim to the human partner. |

The control must fail as a JWT error. If it does not, the classifier is not distinguishing anything and the result is void.

- [ ] **Step 4: Record the decision in the spec**

In §5.6, replace the sentence beginning "So each request runs as `authenticated` carrying an `org_id` claim, by one of two mechanisms chosen by a spike that is the first step of the plan:" with the same sentence followed by:

```markdown
**Decided on <YYYY-MM-DD>: Option <A|B>.** Probe output:

    <paste the JWKS line and both probe lines verbatim>
```

Leave both option descriptions in place; the decision line says which one applies.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md
git commit -m "docs(spec): record the RLS mechanism the JWT spike selected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Delete the scratch script. If `SUPABASE_JWT_SECRET` was added only for the spike and the decision is B, the partner may remove it from `.env.local`.

---

### Task 2: Encrypted secret envelopes

**Files:**
- Create: `src/lib/secrets.ts`
- Test: `tests/secrets.test.ts`

**Interfaces:**
- Produces:
  - `interface MasterKey { id: string; key: Buffer }`
  - `interface SecretEnvelope { k: string; iv: string; tag: string; ct: string }`
  - `interface SecretContext { orgId: string; column: string }`
  - `parseMasterKeys(raw: string | undefined): MasterKey[]`
  - `masterKeysFromEnv(): MasterKey[]`
  - `encryptSecret(plaintext: string, context: SecretContext, keys: MasterKey[]): SecretEnvelope`
  - `decryptSecret(envelope: SecretEnvelope, context: SecretContext, keys: MasterKey[]): string`

- [ ] **Step 1: Write the failing tests**

`tests/secrets.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  parseMasterKeys,
  type MasterKey,
  type SecretEnvelope,
} from "@/lib/secrets";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "11111111-1111-4111-8111-111111111111";
const LEDGER = { orgId: ORG_A, column: "ledger_signing_key_enc" };

function masterKey(id: string): MasterKey {
  return { id, key: crypto.randomBytes(32) };
}
function entry(k: MasterKey): string {
  return `${k.id}:${k.key.toString("base64")}`;
}

describe("parseMasterKeys", () => {
  it("reads id:base64 entries in order, the first being the one that encrypts", () => {
    const v2 = masterKey("v2");
    const v1 = masterKey("v1");
    const keys = parseMasterKeys(`${entry(v2)}, ${entry(v1)}`);
    expect(keys.map((k) => k.id)).toEqual(["v2", "v1"]);
    expect(keys[0].key.equals(v2.key)).toBe(true);
  });

  it("refuses a key that does not decode to 32 bytes", () => {
    expect(() => parseMasterKeys(`v1:${crypto.randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });

  it("refuses an entry without an id", () => {
    expect(() => parseMasterKeys(crypto.randomBytes(32).toString("base64"))).toThrow(/id:base64/);
  });

  it("refuses duplicate ids", () => {
    const a = masterKey("v1");
    const b = masterKey("v1");
    expect(() => parseMasterKeys(`${entry(a)},${entry(b)}`)).toThrow(/duplicate/);
  });

  it("refuses an empty setting, naming it", () => {
    expect(() => parseMasterKeys(undefined)).toThrow(/VESTIARION_MASTER_KEYS/);
    expect(() => parseMasterKeys("  ")).toThrow(/VESTIARION_MASTER_KEYS/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  const keys = [masterKey("v1")];

  it("round-trips", () => {
    const envelope = encryptSecret("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", LEDGER, keys);
    expect(envelope.k).toBe("v1");
    expect(decryptSecret(envelope, LEDGER, keys)).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("uses a fresh IV every time, so equal secrets never share a ciphertext", () => {
    const a = encryptSecret("same", LEDGER, keys);
    const b = encryptSecret("same", LEDGER, keys);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a ciphertext with one byte flipped", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    const ct = Buffer.from(envelope.ct, "base64");
    ct[0] ^= 0x01;
    const tampered: SecretEnvelope = { ...envelope, ct: ct.toString("base64") };
    expect(() => decryptSecret(tampered, LEDGER, keys)).toThrow(/could not decrypt/);
  });

  it("rejects the right key id carrying the wrong key bytes", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, LEDGER, [masterKey("v1")])).toThrow(/could not decrypt/);
  });

  it("rejects a ciphertext copied into another organization's row", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, { ...LEDGER, orgId: ORG_B }, keys)).toThrow(/could not decrypt/);
  });

  it("rejects a ciphertext copied into another column", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, { ...LEDGER, column: "circle_api_key_enc" }, keys)).toThrow(/could not decrypt/);
  });

  it("still decrypts under a retired key after rotation, and encrypts under the new one", () => {
    const old = masterKey("v1");
    const fresh = masterKey("v2");
    const before = encryptSecret("secret", LEDGER, [old]);
    const rotated = [fresh, old];

    expect(decryptSecret(before, LEDGER, rotated)).toBe("secret");
    expect(encryptSecret("secret", LEDGER, rotated).k).toBe("v2");
  });

  it("names the key id it could not find", () => {
    const envelope = encryptSecret("secret", LEDGER, [masterKey("k9")]);
    expect(() => decryptSecret(envelope, LEDGER, keys)).toThrow(/k9/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/secrets.test.ts`
Expected: FAIL — `Cannot find package '@/lib/secrets'`. Then create `src/lib/secrets.ts` containing only `export {};` and re-run: every test fails with `... is not a function`. That is the correct red.

- [ ] **Step 3: Implement**

`src/lib/secrets.ts`:

```ts
import crypto from "node:crypto";

/**
 * Per-organization secrets at rest: Circle credentials and the ledger signing
 * key, encrypted under a platform master key.
 *
 * AES-256-GCM with a fresh 96-bit IV per secret. The additional authenticated
 * data binds each ciphertext to its organization and column, so a ciphertext
 * copied into another tenant's row — or into another column of the same row —
 * fails to decrypt instead of quietly decrypting to someone else's secret.
 *
 * `VESTIARION_MASTER_KEYS` lists `id:base64` entries. The first encrypts; any
 * decrypts. Rotation: prepend a new key, re-encrypt, drop the old one.
 */

export interface MasterKey {
  id: string;
  key: Buffer;
}

export interface SecretEnvelope {
  /** Id of the master key that encrypted it. */
  k: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface SecretContext {
  orgId: string;
  column: string;
}

export function parseMasterKeys(raw: string | undefined): MasterKey[] {
  if (!raw || !raw.trim()) throw new Error("VESTIARION_MASTER_KEYS is not set");
  const keys = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const separator = part.indexOf(":");
      if (separator <= 0) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${index + 1} is not id:base64`);
      }
      const id = part.slice(0, separator);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${index + 1} has an invalid id`);
      }
      const key = Buffer.from(part.slice(separator + 1), "base64");
      if (key.length !== 32) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${id} must decode to 32 bytes, not ${key.length}`);
      }
      return { id, key };
    });
  const ids = new Set<string>();
  for (const { id } of keys) {
    if (ids.has(id)) throw new Error(`VESTIARION_MASTER_KEYS has a duplicate id: ${id}`);
    ids.add(id);
  }
  return keys;
}

/**
 * A platform secret, read here deliberately: it protects every organization's
 * secrets and belongs to no organization's configuration.
 */
export function masterKeysFromEnv(): MasterKey[] {
  return parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
}

function aad(context: SecretContext): Buffer {
  return Buffer.from(`${context.orgId}:${context.column}`, "utf8");
}

export function encryptSecret(plaintext: string, context: SecretContext, keys: MasterKey[]): SecretEnvelope {
  const current = keys[0];
  if (!current) throw new Error("no master key to encrypt with");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(context));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    k: current.id,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptSecret(envelope: SecretEnvelope, context: SecretContext, keys: MasterKey[]): string {
  const master = keys.find((candidate) => candidate.id === envelope.k);
  if (!master) {
    throw new Error(`no master key with id ${envelope.k} for ${context.column} of organization ${context.orgId}`);
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", master.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `could not decrypt ${context.column} of organization ${context.orgId}: wrong master key, or the ciphertext was altered or moved`
    );
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/secrets.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Full verify, then commit**

Run: `npm run verify` — expected exit 0.

```bash
git add src/lib/secrets.ts tests/secrets.test.ts
git commit -m "feat(secrets): encrypt per-organization secrets under a platform master key

AES-256-GCM, fresh IV per secret, org and column bound as AAD so a
ciphertext moved to another row or column fails to decrypt. Master keys
are id-tagged for rotation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0015 — organizations, memberships, and a tenant on every row

**Files:**
- Create: `supabase/migrations/0015_tenancy.sql`
- Create: `tests/support/pglite.ts`
- Create: `tests/tenancy-migration.test.ts`
- Modify: `tests/ledger-parity.test.ts` (use the shared helper)

**Interfaces:**
- Consumes: `bodyHashOf`, `verifyChain`, `LedgerEntryInput`, `LedgerRow` from `@/lib/ledger`; `ledgerKeyId` from `@/lib/ledger-keys`
- Produces:
  - Tables `public.orgs`, `public.memberships`, `public.invitations`; `org_id` on the 11 tenant tables; `created_by` on `invoices` and `milestones`
  - `tests/support/pglite.ts`: `createDatabase(): Promise<PGlite>`, `applyMigrations(db, filter?)`, `migrationFiles(): string[]`, `appendSigned(db, input, privateKey, signingKeyId?): Promise<LedgerRow>`, `FOUNDING_ORG_ID`

- [ ] **Step 1: Create the shared PGlite helper**

`tests/support/pglite.ts` (not a test file — `vitest.config.mts` only collects `tests/**/*.test.ts`):

```ts
import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { bodyHashOf, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";

export const FOUNDING_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * What Supabase provides that a vanilla Postgres does not, and nothing more:
 * the three API roles the migrations grant and revoke against, and the
 * `auth.users` table that the tenancy tables reference.
 */
const SUPABASE_BASELINE = `
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
}

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_BASELINE);
  return db;
}

export async function applyMigrations(db: PGlite, include: (file: string) => boolean = () => true): Promise<void> {
  for (const file of migrationFiles().filter(include)) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

/** Signs the way `appendLedgerEntry` does and hands the body to the real Postgres function to link. */
export async function appendSigned(
  db: PGlite,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}
```

- [ ] **Step 2: Point the existing parity test at the helper**

In `tests/ledger-parity.test.ts`:

1. Replace the imports of `readdirSync`, `readFileSync`, `path`, `PGlite`, and `pgcrypto` with:

```ts
import type { PGlite } from "@electric-sql/pglite";
import { appendSigned, applyMigrations, createDatabase } from "./support/pglite";
```

2. Replace the whole `beforeAll(...)` block with:

```ts
beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);
```

3. Delete the local `appendThroughPostgres` function and replace every call `appendThroughPostgres(x, y)` / `appendThroughPostgres(x, y, z)` with `appendSigned(db, x, y)` / `appendSigned(db, x, y, z)`. Remove the now-unused `bodyHashOf` import if the file no longer uses it.

Run: `npx vitest run tests/ledger-parity.test.ts`
Expected: PASS, 6 tests — unchanged behaviour through the helper.

- [ ] **Step 3: Write the failing migration tests**

`tests/tenancy-migration.test.ts`:

```ts
import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { FOUNDING_ORG_ID, appendSigned, applyMigrations, createDatabase } from "./support/pglite";

/**
 * Migration 0015 against a database shaped like production just before it:
 * every earlier migration applied, then representative rows — including a
 * signed ledger chain and an append-only cycle snapshot — then 0015.
 *
 * What must hold afterwards: every row belongs to the founding organization,
 * the chain is byte-for-byte what it was, the snapshot trigger never fired,
 * and running 0015 again (as `npm run db:migrate` does every time) changes
 * nothing.
 */

const TENANCY = "0015_tenancy.sql";
const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots",
] as const;
const CHAIN_FIELDS = ["seq", "body_hash", "signature", "prev_hash", "hash", "signing_key_id"] as const;

const key = crypto.generateKeyPairSync("ed25519");
const ENTRIES: LedgerEntryInput[] = [
  { actor: "agent", domain: "compliance", action: "compliance_sweep", summary: "Re-screened 7 of 7", detail: { changed: 0 } },
  { actor: "agent", domain: "treasury", action: "hold", summary: "Treasury: hold 0 USDC", detail: { amount: 0 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "Agent cycle complete", detail: {} },
];

let db: PGlite;
let chainBefore: LedgerRow[];
let countsBefore: Record<string, number>;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    out[table] = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
  }
  return out;
}

async function chain(): Promise<LedgerRow[]> {
  return (await db.query<LedgerRow>("select * from ledger_entries order by seq")).rows;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db, (file) => file < TENANCY);

  const counterparty = await db.query<{ id: string }>(
    "insert into counterparties (name, role) values ('Meridian Works', 'vendor') returning id"
  );
  await db.query(
    "insert into invoices (direction, counterparty_id, amount, due_date) values ('payable', $1, 12.5, now() + interval '7 days')",
    [counterparty.rows[0].id]
  );
  const run = await db.query<{ id: string }>(
    `insert into cycle_runs (started_at, finished_at, duration_ms, clock_mode, decision_count, chain_mode, screening_mode, status)
     values (now(), now(), 10, 'real', 1, 'live', 'simulate', 'completed') returning id`
  );
  await db.query(
    `insert into cycle_snapshots (cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, now(), '{}'::jsonb, 1, 0, 0, 0, 0, 0, 'live')`,
    [run.rows[0].id]
  );
  for (const entry of ENTRIES) await appendSigned(db, entry, key.privateKey);

  chainBefore = await chain();
  countsBefore = await counts();

  await applyMigrations(db, (file) => file === TENANCY);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("migration 0015", () => {
  it("creates the founding organization, live", async () => {
    const orgs = await db.query<{ id: string; slug: string; name: string; mode: string }>("select id, slug, name, mode from orgs");
    expect(orgs.rows).toEqual([{ id: FOUNDING_ORG_ID, slug: "founding", name: "Vestiarion workspace", mode: "live" }]);
  });

  it("gives every existing row to the founding organization", async () => {
    for (const table of TENANT_TABLES) {
      const stray = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where org_id is distinct from $1`,
        [FOUNDING_ORG_ID]
      );
      expect(stray.rows[0].n, table).toBe(0);
    }
    expect(await counts()).toEqual(countsBefore);
  });

  it("leaves the founding chain byte for byte as it was, and still verifying", async () => {
    const after = await chain();
    const pick = (rows: LedgerRow[]) =>
      rows.map((row) => Object.fromEntries(CHAIN_FIELDS.map((field) => [field, row[field]])));

    expect(pick(after)).toEqual(pick(chainBefore));
    expect(verifyChain(after, { active: key.publicKey, retired: [] })).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("never fired the snapshot trigger, which still rejects updates", async () => {
    // Backfilling with UPDATE would have been refused by this trigger; the
    // column default fills existing rows without one.
    await expect(db.query("update cycle_snapshots set total_liquid = 2")).rejects.toThrow(/append-only/);
  });

  it("is safe to run again, as npm run db:migrate does on every invocation", async () => {
    await applyMigrations(db, (file) => file === TENANCY);

    expect((await db.query<{ n: number }>("select count(*)::int as n from orgs")).rows[0].n).toBe(1);
    expect(await counts()).toEqual(countsBefore);
  });

  it("files a legacy insert under the founding organization until Plan 2 removes the default", async () => {
    const row = await db.query<{ org_id: string }>(
      "insert into counterparties (name, role) values ('Legacy insert', 'client') returning org_id"
    );
    expect(row.rows[0].org_id).toBe(FOUNDING_ORG_ID);
    await db.query("delete from counterparties where name = 'Legacy insert'");
  });

  it("records who created invoices and milestones", async () => {
    const columns = await db.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'created_by' order by table_name`
    );
    expect(columns.rows.map((row) => row.table_name)).toEqual(["invoices", "milestones", "orgs"]);
  });

  it("keeps the new tables away from the public API roles", async () => {
    for (const table of ["orgs", "memberships", "invitations"]) {
      const privileges = await db.query<{ anon: boolean; authed: boolean; service: boolean }>(
        `select has_table_privilege('anon', 'public.${table}', 'select') as anon,
                has_table_privilege('authenticated', 'public.${table}', 'select') as authed,
                has_table_privilege('service_role', 'public.${table}', 'select') as service`
      );
      expect(privileges.rows[0], table).toEqual({ anon: false, authed: false, service: true });
    }
  });

  it("refuses a slug that is not lowercase letters, digits and inner hyphens", async () => {
    await expect(db.query("insert into orgs (slug, name) values ('Founding-2', 'x')")).rejects.toThrow();
    await expect(db.query("insert into orgs (slug, name) values ('-ab', 'x')")).rejects.toThrow();
  });

  it("allows at most one membership per person per organization", async () => {
    const user = "22222222-2222-4222-8222-222222222222";
    await db.query("insert into auth.users (id, email) values ($1, 'a@example.com')", [user]);
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [FOUNDING_ORG_ID, user]);
    await expect(
      db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [FOUNDING_ORG_ID, user])
    ).rejects.toThrow();
    await expect(
      db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'superuser')", [FOUNDING_ORG_ID, crypto.randomUUID()])
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run tests/tenancy-migration.test.ts`
Expected: FAIL in `beforeAll` — `ENOENT` or no file matched for `0015_tenancy.sql`, so `orgs` does not exist: `relation "orgs" does not exist`.

- [ ] **Step 5: Write the migration**

`supabase/migrations/0015_tenancy.sql`:

```sql
-- Organizations, memberships, invitations — and a tenant on every row.
--
-- Everything that exists today becomes the founding organization. Its ledger
-- chain is not touched: org_id is a new column outside both hashes, so every
-- entry verifies byte for byte as before.
--
-- The backfill uses ADD COLUMN ... NOT NULL DEFAULT, never UPDATE. Postgres
-- fills existing rows from the default without running an UPDATE, which
-- matters because cycle_snapshots rejects every UPDATE by trigger.
--
-- TRANSITIONAL: each org_id keeps defaulting to the founding organization so
-- that code which does not yet know about organizations keeps writing correct
-- rows. Plan 2 of the identity-and-tenancy work drops these defaults once
-- every write names its organization explicitly.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.orgs (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique
                              check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name                      text not null,
  mode                      text not null default 'sandbox' check (mode in ('sandbox', 'live')),
  created_by                uuid references auth.users(id),
  created_at                timestamptz not null default now(),
  last_active_at            timestamptz not null default now(),
  ledger_signing_key_enc    jsonb,
  circle_api_key_enc        jsonb,
  circle_entity_secret_enc  jsonb,
  settings                  jsonb not null default '{}'::jsonb
);

create table if not exists public.memberships (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  token_hash   text not null unique,
  invited_by   uuid not null references auth.users(id),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

insert into public.orgs (id, slug, name, mode)
values ('00000000-0000-4000-8000-000000000001', 'founding', 'Vestiarion workspace', 'live')
on conflict (id) do nothing;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots'
  ]
  loop
    execute format(
      'alter table public.%I add column if not exists org_id uuid not null '
      'default ''00000000-0000-4000-8000-000000000001'' references public.orgs(id) on delete restrict',
      t
    );
    execute format('create index if not exists %I on public.%I (org_id)', t || '_org_idx', t);
  end loop;
end $$;

alter table public.invoices   add column if not exists created_by uuid references auth.users(id);
alter table public.milestones add column if not exists created_by uuid references auth.users(id);

-- Same posture as 0003: the browser roles get nothing; the server's service
-- role does. Plan 2 adds policies that let `authenticated` see its own
-- organization and nothing else.
do $$
declare
  t text;
begin
  foreach t in array array['orgs', 'memberships', 'invitations']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated', t);
    execute format('grant all privileges on table public.%I to service_role', t);
  end loop;
end $$;

-- Rollback (loses every organization, membership and invitation):
-- do $$ declare t text; begin
--   foreach t in array array['accounts','counterparties','invoices','milestones','treasury_actions',
--     'compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs','cycle_snapshots']
--   loop execute format('alter table public.%I drop column if exists org_id', t); end loop; end $$;
-- alter table public.invoices drop column if exists created_by;
-- alter table public.milestones drop column if exists created_by;
-- drop table if exists public.invitations, public.memberships, public.orgs;
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run tests/tenancy-migration.test.ts tests/ledger-parity.test.ts`
Expected: PASS — 10 + 6 tests.

- [ ] **Step 7: Full verify, then commit**

Run: `npm run verify` — expected exit 0.

```bash
git add supabase/migrations/0015_tenancy.sql tests/support/pglite.ts tests/tenancy-migration.test.ts tests/ledger-parity.test.ts
git commit -m "feat(db): organizations, memberships, and a tenant on every row

Migration 0015 gives every existing row to a founding organization via
ADD COLUMN ... DEFAULT (never UPDATE — cycle_snapshots rejects updates by
trigger). The founding chain is unchanged byte for byte. Idempotent, since
db:migrate re-runs everything. The org_id default is transitional until
writes name their organization.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sessions — Supabase SSR client, proxy, and the authoritative check

**Files:**
- Modify: `package.json`, `package-lock.json` (add `@supabase/ssr` 0.12.7)
- Create: `src/lib/auth/env.ts`, `src/lib/auth/routes.ts`, `src/lib/auth/supabase-server.ts`, `src/lib/auth/session.ts`, `src/proxy.ts`
- Test: `tests/auth-routes.test.ts`

**Interfaces:**
- Produces:
  - `supabaseAuthEnv(): { url: string; anonKey: string }` (`src/lib/auth/env.ts`)
  - `DEFAULT_AFTER_LOGIN = "/onboarding"`, `requiresSession(pathname: string): boolean`, `loginRedirectFor(pathname: string, search: string, signedIn: boolean): string | null`, `safeNext(next: string | null | undefined): string` (`src/lib/auth/routes.ts`)
  - `createSupabaseServerClient(): Promise<SupabaseClient>` (`src/lib/auth/supabase-server.ts`)
  - `interface SessionUser { id: string; email: string | null }`, `getSessionUser(): Promise<SessionUser | null>`, `verifySession(returnTo: string): Promise<SessionUser>` (`src/lib/auth/session.ts`)

- [ ] **Step 1: Install the pinned SSR package**

Run: `npm install --save-exact @supabase/ssr@0.12.7`
Expected: `package.json` gains `"@supabase/ssr": "0.12.7"`; `npm run check:lock` passes.

- [ ] **Step 2: Write the failing tests**

`tests/auth-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, loginRedirectFor, requiresSession, safeNext } from "@/lib/auth/routes";

describe("safeNext — where to go after signing in", () => {
  it.each([
    ["/o/founding/console", "/o/founding/console"],
    ["/o/founding/audit?domain=treasury", "/o/founding/audit?domain=treasury"],
    ["/o/founding/audit#seq-12", "/o/founding/audit#seq-12"],
    ["/onboarding", "/onboarding"],
  ])("keeps a same-site path: %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["//evil.example"],
    ["/\\evil.example"],
    ["https://evil.example/o/founding"],
    ["javascript:alert(1)"],
    ["o/founding/console"],
    ["/o/founding\n/console"],
  ])("sends anything else to the default: %s", (input) => {
    expect(safeNext(input as string | null | undefined)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("requiresSession", () => {
  it.each([
    ["/o/founding/console", true],
    ["/o/founding", true],
    ["/onboarding", true],
    ["/", false],
    ["/login", false],
    ["/auth/callback", false],
    ["/api/ledger/verify", false],
  ])("%s → %s", (pathname, expected) => {
    expect(requiresSession(pathname)).toBe(expected);
  });
});

describe("loginRedirectFor", () => {
  it("sends a signed-out visitor of a product page to login, remembering the page", () => {
    expect(loginRedirectFor("/o/founding/audit", "?domain=treasury", false)).toBe(
      "/login?next=%2Fo%2Ffounding%2Faudit%3Fdomain%3Dtreasury"
    );
  });

  it("lets a signed-in visitor through", () => {
    expect(loginRedirectFor("/o/founding/audit", "", true)).toBeNull();
  });

  it("never redirects a public page", () => {
    expect(loginRedirectFor("/", "", false)).toBeNull();
    expect(loginRedirectFor("/login", "?next=%2Fo", false)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/auth-routes.test.ts`
Expected: FAIL — `Cannot find package '@/lib/auth/routes'`.

- [ ] **Step 4: Implement the pure routing rules**

`src/lib/auth/routes.ts`:

```ts
/**
 * Which paths need a session, and where a person may be sent after signing
 * in. Pure, so the proxy, the login action and the callback all agree.
 */

export const DEFAULT_AFTER_LOGIN = "/onboarding";

const BASE = "http://vestiarion.invalid";

export function requiresSession(pathname: string): boolean {
  return pathname === "/onboarding" || pathname === "/o" || pathname.startsWith("/o/");
}

/** The login URL for a signed-out request to a protected page, or null to let it through. */
export function loginRedirectFor(pathname: string, search: string, signedIn: boolean): string | null {
  if (signedIn || !requiresSession(pathname)) return null;
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

/**
 * An open redirect turns a trusted sign-in link into a phishing link, so only
 * a same-origin absolute path survives. Resolving against a fixed base catches
 * what string checks miss: browsers read `/\evil` as `//evil`.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return DEFAULT_AFTER_LOGIN;
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  try {
    const resolved = new URL(next, BASE);
    if (resolved.origin !== BASE) return DEFAULT_AFTER_LOGIN;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/auth-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the env reader, server client, session DAL, and proxy**

`src/lib/auth/env.ts`:

```ts
/**
 * The two Supabase settings the browser-facing auth flow needs. Both are
 * public by design (the anon key only reaches what RLS and grants allow), and
 * both are platform settings, not a business's configuration — so they are
 * read here rather than through `VestiarionConfig`.
 */
export function supabaseAuthEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set for sign-in");
  }
  return { url, anonKey };
}
```

`src/lib/auth/supabase-server.ts`:

```ts
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAuthEnv } from "./env";

/**
 * A Supabase client bound to the signed-in person's cookies. For auth only —
 * it acts as that person, not as the service role, and must not be used to
 * read tenant tables.
 */
export async function createSupabaseServerClient() {
  const store = await cookies();
  const { url, anonKey } = supabaseAuthEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes sessions on every navigation, so nothing is lost.
        }
      },
    },
  });
}
```

`src/lib/auth/session.ts`:

```ts
import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "./supabase-server";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * The authoritative session check. `getUser()` asks Supabase Auth to validate
 * the token rather than trusting the cookie, which is what the proxy's
 * optimistic check cannot do. Memoized per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});

export async function verifySession(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}
```

`src/proxy.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAuthEnv } from "@/lib/auth/env";
import { loginRedirectFor } from "@/lib/auth/routes";

/**
 * Refreshes an expiring session and sends signed-out visitors of product pages
 * to /login. Optimistic only — it reads the cookie and never the database; the
 * pages re-check with `verifySession()`.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseAuthEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [header, value] of Object.entries(headers ?? {})) response.headers.set(header, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const target = loginRedirectFor(request.nextUrl.pathname, request.nextUrl.search, Boolean(data?.claims));
  if (target) return NextResponse.redirect(new URL(target, request.url));
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
```

- [ ] **Step 7: Verify it compiles and the suite is green**

Run: `npm run verify`
Expected: exit 0. If `tsc` reports a mismatch in the `setAll` signature, read `node_modules/@supabase/ssr/dist/main/types.d.ts` for `SetAllCookies` and match it — do not cast.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/auth/env.ts src/lib/auth/routes.ts src/lib/auth/supabase-server.ts src/lib/auth/session.ts src/proxy.ts tests/auth-routes.test.ts
git commit -m "feat(auth): Supabase sessions, an optimistic proxy, and an authoritative check

proxy.ts refreshes sessions and redirects signed-out visitors of /o/* and
/onboarding; verifySession() re-validates with getUser(). safeNext() keeps
post-login redirects on this site.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Signing in — login page, callback, sign-out

**Files:**
- Create: `src/lib/auth/messages.ts`, `src/app/login/actions.ts`, `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/components/auth/LoginForm.tsx`, `src/app/auth/callback/route.ts`
- Test: `tests/auth-messages.test.ts`

**Interfaces:**
- Consumes: `safeNext` (Task 4), `createSupabaseServerClient` (Task 4)
- Produces:
  - `loginErrorMessage(code: string | null | undefined): string | null`
  - Server actions: `signInWithEmail(prev: LoginState, formData: FormData): Promise<LoginState>`, `signInWithGoogle(formData: FormData): Promise<void>`, `signOut(): Promise<void>`; `interface LoginState { ok: boolean; message: string }`
  - `googleSignInEnabled(): boolean`

- [ ] **Step 1: Write the failing test**

`tests/auth-messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "@/lib/auth/messages";

describe("loginErrorMessage", () => {
  it("explains a link that failed to exchange, which is usually a different browser", () => {
    expect(loginErrorMessage("link")).toMatch(/same browser/);
  });

  it("explains a Google sign-in that did not start", () => {
    expect(loginErrorMessage("google")).toMatch(/Google/);
  });

  it("says nothing for no code or an unknown one, rather than echoing input", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("<script>")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-messages.test.ts`
Expected: FAIL — `Cannot find package '@/lib/auth/messages'`.

- [ ] **Step 3: Implement the messages**

`src/lib/auth/messages.ts`:

```ts
/**
 * Login error codes arrive in the URL, so they are looked up, never echoed.
 */
const MESSAGES: Record<string, string> = {
  link:
    "That sign-in link could not be used. It may have expired, or it was opened in a different browser " +
    "from the one that asked for it. Request a new link here and open it in the same browser.",
  google: "Google sign-in could not start. Use an email link instead, or try again in a minute.",
};

export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/auth-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Server actions**

`src/app/login/actions.ts`:

```ts
"use server";

import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

export interface LoginState {
  ok: boolean;
  message: string;
}

/** Supabase checks this against its allow-list of redirect URLs, so a forged Host cannot send the link elsewhere. */
async function callbackUrl(next: FormDataEntryValue | null): Promise<string> {
  const h = await headers();
  const origin = h.get("origin") ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const target = safeNext(typeof next === "string" ? next : null);
  return `${origin}/auth/callback?next=${encodeURIComponent(target)}`;
}

export async function signInWithEmail(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, message: "Enter a valid email address." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: await callbackUrl(formData.get("next")), shouldCreateUser: true },
  });
  if (error) {
    console.error("sign-in link failed", error.message);
    return { ok: false, message: "We could not send a sign-in link just now. Try again in a minute." };
  }
  return { ok: true, message: `Check ${email} for a sign-in link, and open it in this browser.` };
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: await callbackUrl(formData.get("next")) },
  });
  if (error || !data.url) redirect("/login?error=google");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

- [ ] **Step 6: The form and the page**

`src/components/auth/LoginForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { signInWithEmail, type LoginState } from "@/app/login/actions";

const INITIAL: LoginState = { ok: false, message: "" };

export default function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInWithEmail, INITIAL);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm font-medium text-ink" htmlFor="email">Work email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        className="w-full rounded-md border border-line bg-ground px-3 py-2 text-sm text-ink"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-ground disabled:opacity-70"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-proof" : "text-sm text-refused"}>{state.message}</p>
      )}
    </form>
  );
}
```

`src/app/login/page.tsx`:

```tsx
import LoginForm from "@/components/auth/LoginForm";
import { loginErrorMessage } from "@/lib/auth/messages";
import { safeNext } from "@/lib/auth/routes";
import { signInWithGoogle } from "./actions";

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

/** Google appears only once the operator has enabled the provider in Supabase and said so here. */
function googleSignInEnabled(): boolean {
  return process.env.AUTH_GOOGLE_ENABLED === "true";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : null);
  const error = loginErrorMessage(typeof query.error === "string" ? query.error : null);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">Sign in to Vestiarion</h1>
      <p className="mt-2 text-sm text-ink-3">We email you a link. No password to remember or leak.</p>
      {error && <p role="alert" className="mt-4 rounded-md border border-refused p-3 text-sm text-refused">{error}</p>}
      <div className="surface-shadow mt-6 rounded-2xl border border-line bg-surface p-5">
        <LoginForm next={next} />
        {googleSignInEnabled() && (
          <form action={signInWithGoogle} className="mt-4 border-t border-line pt-4">
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="w-full rounded-md border border-ink-3 px-3.5 py-2 text-sm font-medium text-ink hover:bg-raised">
              Continue with Google
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 7: The callback**

`src/app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Exchanges the one-time code from a magic link or OAuth redirect for a
 * session. The exchange needs the PKCE verifier cookie set when the link was
 * requested, so a link opened in another browser fails here — and the login
 * page says exactly that.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.url));
    console.error("sign-in code exchange failed", error.message);
  }
  return NextResponse.redirect(new URL(`/login?error=link&next=${encodeURIComponent(next)}`, request.url));
}
```

- [ ] **Step 8: `/signup` is the same flow**

With an email link, signing up and signing in are one action: the first link creates the account (`shouldCreateUser: true`). The spec names `/signup` as a public route, so it exists and says so by arriving at the same form.

`src/app/signup/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/auth/routes";

type SignupPageProps = { searchParams: Promise<{ next?: string | string[] }> };

/** An email link signs a new person up and an existing one in; there is one form for both. */
export default async function SignupPage({ searchParams }: SignupPageProps) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : null);
  redirect(`/login?next=${encodeURIComponent(next)}`);
}
```

- [ ] **Step 9: Verify in the running app**

Run: `npm run verify` — expected exit 0.

Start the dev server (`preview_start` with name `dev`), then:
- `/signup` redirects to `/login?next=%2Fonboarding`.
- `/login` renders the form; submitting `not-an-email` shows "Enter a valid email address." without a network call.
- `/login?error=link` shows the same-browser explanation. `/login?error=%3Cscript%3E` shows no error box.
- `/auth/callback` with no code redirects to `/login?error=link&next=%2Fonboarding`.

Do **not** submit a real address here; sending a real link is the human partner's step in Task 9.

- [ ] **Step 10: Commit**

```bash
git add src/lib/auth/messages.ts src/app/login src/app/signup src/components/auth/LoginForm.tsx src/app/auth/callback/route.ts tests/auth-messages.test.ts
git commit -m "feat(auth): sign in by email link or Google, and sign out

The callback exchanges the one-time code; a link opened in another
browser fails there and the login page says so in words. Google appears
only when AUTH_GOOGLE_ENABLED=true.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Organizations in the URL — membership gate, route move, links, redirects

**Files:**
- Create: `src/lib/auth/org-paths.ts`, `src/lib/auth/roles.ts`, `src/lib/auth/membership.ts`, `src/lib/auth/revalidate.ts`, `src/app/o/[slug]/layout.tsx`, `src/app/onboarding/page.tsx`
- Move: `src/app/{console,audit,compliance,contractors,counterparties,insights,invoices}` → `src/app/o/[slug]/…`
- Delete: `src/app/app/page.tsx`
- Modify: `next.config.ts`; `src/components/vx/Shell.tsx`; `src/components/vx/DecisionCard.tsx`; `src/components/vx/CycleReport.tsx`; `src/components/vx/AuditLedger.tsx`; the seven moved pages; `src/app/page.tsx`; `src/app/actions/{agent,intake,milestones}.ts` (revalidation only)
- Test: `tests/org-paths.test.ts`, `tests/roles.test.ts`

**Interfaces:**
- Consumes: `verifySession` (Task 4), `signOut` (Task 5), `supabase`/`unwrap` from `@/lib/supabase`
- Produces:
  - `FOUNDING_ORG_SLUG = "founding"`, `isValidSlug(slug: string): boolean`, `orgHref(slug: string, path: string): string`, `LEGACY_PRODUCT_PATHS`, `legacyRedirects(): { source: string; destination: string; permanent: false }[]` (`org-paths.ts`, **no imports**)
  - `ORG_ROLES`, `type OrgRole`, `isOrgRole(value: unknown): value is OrgRole`, `canMutate(role: OrgRole | null | undefined): boolean` (`roles.ts`, no imports)
  - `interface OrgMembership { orgId: string; slug: string; name: string; mode: "sandbox" | "live"; role: OrgRole }`, `membershipsOf(userId: string): Promise<OrgMembership[]>`, `membershipFor(userId: string, slug: string): Promise<OrgMembership | null>`
  - `revalidateOrgPages(): void`
  - `ProductShell` gains required prop `orgSlug: string`; `DecisionCard`, `CycleReport`, `DomainFilter` gain required prop `orgSlug: string`

- [ ] **Step 1: Write the failing tests**

`tests/org-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FOUNDING_ORG_SLUG, isValidSlug, legacyRedirects, orgHref } from "@/lib/auth/org-paths";

describe("isValidSlug — mirrors the orgs.slug check in 0015", () => {
  it.each([
    ["founding", true],
    ["a-b", true],
    ["abc123", true],
    ["a".repeat(40), true],
    ["Founding", false],
    ["ab", false],
    ["-ab", false],
    ["ab-", false],
    ["a b", false],
    ["a".repeat(41), false],
    ["", false],
  ])("%s → %s", (slug, expected) => {
    expect(isValidSlug(slug)).toBe(expected);
  });
});

describe("orgHref", () => {
  it("prefixes an organization path, keeping query and hash", () => {
    expect(orgHref("founding", "/audit?domain=treasury#seq-12")).toBe("/o/founding/audit?domain=treasury#seq-12");
  });

  it("refuses a slug that could not be real", () => {
    expect(() => orgHref("Founding", "/audit")).toThrow(/slug/);
  });

  it("refuses a relative path", () => {
    expect(() => orgHref("founding", "audit")).toThrow(/start with/);
  });
});

describe("legacyRedirects — old bookmarks keep working", () => {
  it("sends every former product path to the founding organization, temporarily", () => {
    expect(legacyRedirects()).toEqual([
      { source: "/console", destination: "/o/founding/console", permanent: false },
      { source: "/audit", destination: "/o/founding/audit", permanent: false },
      { source: "/compliance", destination: "/o/founding/compliance", permanent: false },
      { source: "/contractors", destination: "/o/founding/contractors", permanent: false },
      { source: "/counterparties", destination: "/o/founding/counterparties", permanent: false },
      { source: "/insights", destination: "/o/founding/insights", permanent: false },
      { source: "/invoices", destination: "/o/founding/invoices", permanent: false },
      { source: "/app", destination: "/o/founding/console", permanent: false },
    ]);
    expect(FOUNDING_ORG_SLUG).toBe("founding");
  });
});
```

`tests/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canMutate, isOrgRole } from "@/lib/auth/roles";

describe("canMutate — Plan 1: only an owner changes anything", () => {
  it.each([
    ["owner", true],
    ["admin", false],
    ["approver", false],
    ["viewer", false],
    [null, false],
    [undefined, false],
  ] as const)("%s → %s", (role, expected) => {
    expect(canMutate(role)).toBe(expected);
  });
});

describe("isOrgRole", () => {
  it("accepts the four roles and nothing else", () => {
    for (const role of ["owner", "admin", "approver", "viewer"]) expect(isOrgRole(role)).toBe(true);
    for (const value of ["Owner", "superuser", "", null, 1]) expect(isOrgRole(value)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/org-paths.test.ts tests/roles.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the pure modules**

`src/lib/auth/org-paths.ts`:

```ts
/**
 * Organization URLs. Deliberately free of imports: `next.config.ts` loads this
 * file to build its redirects.
 */

export const FOUNDING_ORG_SLUG = "founding";

/** Mirrors the `orgs.slug` check constraint in migration 0015. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function orgHref(slug: string, path: string): string {
  if (!isValidSlug(slug)) throw new Error(`not an organization slug: ${slug}`);
  if (!path.startsWith("/")) throw new Error(`organization paths start with "/": ${path}`);
  return `/o/${slug}${path}`;
}

export const LEGACY_PRODUCT_PATHS = [
  "/console", "/audit", "/compliance", "/contractors", "/counterparties", "/insights", "/invoices",
] as const;

/** Temporary (307): these paths belonged to the only business there was. */
export function legacyRedirects(): { source: string; destination: string; permanent: false }[] {
  return [
    ...LEGACY_PRODUCT_PATHS.map((path) => ({
      source: path,
      destination: orgHref(FOUNDING_ORG_SLUG, path),
      permanent: false as const,
    })),
    { source: "/app", destination: orgHref(FOUNDING_ORG_SLUG, "/console"), permanent: false as const },
  ];
}
```

`src/lib/auth/roles.ts`:

```ts
export const ORG_ROLES = ["owner", "admin", "approver", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Plan 1's entire permission model. Plan 3 replaces this with the full role
 * table from spec §7; until then the only safe rule with a single user is that
 * only an owner changes anything.
 */
export function canMutate(role: OrgRole | null | undefined): boolean {
  return role === "owner";
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/org-paths.test.ts tests/roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Membership lookup, revalidation helper, org layout, onboarding page**

`src/lib/auth/membership.ts`:

```ts
import "server-only";
import { cache } from "react";
import { supabase, unwrap } from "@/lib/supabase";
import { isValidSlug } from "./org-paths";
import type { OrgRole } from "./roles";

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
}

type MembershipRow = {
  role: OrgRole;
  orgs: { id: string; slug: string; name: string; mode: "sandbox" | "live" };
};

const SELECT = "role, orgs!inner(id, slug, name, mode)";

function toMembership(row: MembershipRow): OrgMembership {
  return { orgId: row.orgs.id, slug: row.orgs.slug, name: row.orgs.name, mode: row.orgs.mode, role: row.role };
}

/**
 * Through the service role: organizations and memberships are platform data,
 * the one thing that must be readable before a tenant is known.
 */
export const membershipsOf = cache(async (userId: string): Promise<OrgMembership[]> => {
  const rows = unwrap(await supabase().from("memberships").select(SELECT).eq("user_id", userId)) as unknown as MembershipRow[];
  return rows.map(toMembership).sort((a, b) => a.name.localeCompare(b.name));
});

export const membershipFor = cache(async (userId: string, slug: string): Promise<OrgMembership | null> => {
  // A slug that could not exist never reaches the database.
  if (!isValidSlug(slug)) return null;
  const rows = unwrap(
    await supabase().from("memberships").select(SELECT).eq("user_id", userId).eq("orgs.slug", slug).limit(1)
  ) as unknown as MembershipRow[];
  return rows[0] ? toMembership(rows[0]) : null;
});
```

`src/lib/auth/revalidate.ts`:

```ts
import { revalidatePath } from "next/cache";

/** Everything under an organization's layout, on its next visit. */
export function revalidateOrgPages(): void {
  revalidatePath("/o/[slug]", "layout");
}
```

`src/app/o/[slug]/layout.tsx`:

```tsx
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { membershipFor } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";

type OrgLayoutProps = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * Every product page passes through here. A non-member gets the same 404 as a
 * slug that does not exist, so the existence of another business is never
 * disclosed.
 */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { slug } = await params;
  const user = await verifySession(`/o/${slug}/console`);
  if (!(await membershipFor(user.id, slug))) notFound();
  return children;
}
```

`src/app/onboarding/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";

/**
 * Where a signed-in person lands. One workspace: straight in. Several: choose.
 * None: said plainly — creating a workspace yourself arrives with self-serve
 * onboarding (Plan 3).
 */
export default async function OnboardingPage() {
  const user = await verifySession("/onboarding");
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) redirect(orgHref(memberships[0].slug, "/console"));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">
        {memberships.length ? "Choose a workspace" : "No workspace yet"}
      </h1>
      {memberships.length ? (
        <ul className="mt-6 space-y-2">
          {memberships.map((membership) => (
            <li key={membership.orgId}>
              <Link
                href={orgHref(membership.slug, "/console")}
                className="surface-shadow flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-ink hover:bg-raised"
              >
                <span>{membership.name}</span>
                <span className="font-mono text-xs text-ink-3">{membership.role} · {membership.mode}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-3">
          You are signed in as {user.email ?? "this account"}, but no workspace has added you yet. Ask an owner to
          invite you. Creating your own workspace is coming shortly.
        </p>
      )}
      <form action={signOut} className="mt-8">
        <button type="submit" className="text-sm text-ink-3 underline hover:text-ink">Sign out</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Move the product routes**

```bash
mkdir -p "src/app/o/[slug]"
for page in console audit compliance contractors counterparties insights invoices; do
  git mv "src/app/$page" "src/app/o/[slug]/$page"
done
git rm src/app/app/page.tsx
```

- [ ] **Step 7: Redirect old paths**

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  async redirects() {
    return legacyRedirects();
  },
};

export default nextConfig;
```

If `next build` cannot resolve the relative import, inline the array `legacyRedirects()` returns — the `org-paths` test still pins its contents.

- [ ] **Step 8: Give the shell and shared components the organization**

`src/components/vx/Shell.tsx` — change the `NAV` entries from `href` to `path` and build links through `orgHref`:

```tsx
const NAV = [
  { key: "treasury", path: "/console", label: "Treasury" },
  { key: "insights", path: "/insights", label: "Insights" },
  { key: "invoices", path: "/invoices", label: "AP / AR" },
  { key: "counterparties", path: "/counterparties", label: "Counterparties" },
  { key: "contractors", path: "/contractors", label: "Contractors" },
  { key: "compliance", path: "/compliance", label: "Compliance" },
  { key: "audit", path: "/audit", label: "Audit log" },
] as const;
```

In `ProductShell`'s props add `orgSlug: string` (required) alongside `active`, `day`, `clockMode`, `lastCycleAt`; replace `href={item.href}` with `href={orgHref(orgSlug, item.path)}`; add `import { orgHref } from "@/lib/auth/org-paths";` and `import { signOut } from "@/app/login/actions";`; and in the header, next to the status pills, add:

```tsx
<form action={signOut}>
  <button type="submit" className="text-[0.8125rem] text-ink-3 hover:text-ink">Sign out</button>
</form>
```

`src/components/vx/DecisionCard.tsx` — signature becomes `DecisionCard({ decision, compact = false, orgSlug }: { decision: Decision; compact?: boolean; orgSlug: string })`, and the audit link becomes `href={orgHref(orgSlug, `/audit#seq-${decision.auditSeq}`)}`.

`src/components/vx/CycleReport.tsx` — add `orgSlug: string` to the props; the link becomes `href={orgHref(orgSlug, `/audit?since=${since}#seq-${rows.at(-1)!.seq}`)}`.

`src/components/vx/AuditLedger.tsx` — `DomainFilter({ active, orgSlug }: { active?: Domain; orgSlug: string })`; its two links become `href={orgHref(orgSlug, "/audit")}` and `href={orgHref(orgSlug, `/audit?domain=${domain}`)}`.

Import `orgHref` in each.

- [ ] **Step 9: Let the compiler list every call site, and fix each**

Run: `npm run typecheck`
Expected: errors for every `ProductShell`, `DecisionCard`, `CycleReport`, `DomainFilter` missing `orgSlug`. In each moved page:

1. Read the slug. For pages with no props today (`compliance`, `contractors`, `counterparties`, `insights`):

```tsx
export default async function CompliancePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
```

For `console`, `audit`, `invoices`, add `params: Promise<{ slug: string }>` to the existing props type and `const { slug } = await params;` beside the existing `await searchParams`.

2. Pass `orgSlug={slug}` to every `ProductShell`, `DecisionCard`, `CycleReport`, `DomainFilter` the compiler named.

3. Replace each hard-coded product link with `orgHref(slug, …)` — the complete list:

| File | From | To |
|---|---|---|
| `o/[slug]/console/page.tsx` | `href="/audit"` | `href={orgHref(slug, "/audit")}` |
| | `href="/invoices"` | `href={orgHref(slug, "/invoices")}` |
| | `href="/audit?domain=treasury"` | `href={orgHref(slug, "/audit?domain=treasury")}` |
| `o/[slug]/compliance/page.tsx` | `` href={`/audit#seq-${lastSweep.seq}`} `` | `` href={orgHref(slug, `/audit#seq-${lastSweep.seq}`)} `` |
| | `href="/audit?domain=compliance"` | `href={orgHref(slug, "/audit?domain=compliance")}` |
| | `` href={`/audit#seq-${entry.seq}`} `` | `` href={orgHref(slug, `/audit#seq-${entry.seq}`)} `` |
| `o/[slug]/audit/page.tsx` | `` href={`/audit?before=${entries.at(-1)!.seq}${domain ? `&domain=${domain}` : ""}`} `` | `` href={orgHref(slug, `/audit?before=${entries.at(-1)!.seq}${domain ? `&domain=${domain}` : ""}`)} `` |
| `o/[slug]/invoices/page.tsx` | `href="/invoices"` | `href={orgHref(slug, "/invoices")}` |
| `src/app/page.tsx` (landing) | `href="/insights"` (7 places) | `href={orgHref(FOUNDING_ORG_SLUG, "/insights")}` |
| | `href="/audit"` (3 places) | `href={orgHref(FOUNDING_ORG_SLUG, "/audit")}` |
| | `href="/console"` (3 places) | `href={orgHref(FOUNDING_ORG_SLUG, "/console")}` |

In `src/app/page.tsx` add `import { FOUNDING_ORG_SLUG, orgHref } from "@/lib/auth/org-paths";`. Each moved page imports `orgHref` from the same module.

The landing page's evidence links now lead to a sign-in: the product pages are a business's books and are no longer public. The aggregate figures on the landing page, and `GET /api/ledger/verify`, stay public.

Run until clean: `npm run typecheck`. Then confirm nothing was missed:

Run: `grep -rnE "href=[\"'{\`]+/(console|audit|compliance|contractors|counterparties|insights|invoices)" src`
Expected: no output.

- [ ] **Step 10: Revalidate organization pages, not dead paths**

In `src/app/actions/agent.ts`, `intake.ts`, `milestones.ts`: replace every `revalidatePath("/console", "layout")`, `revalidatePath("/counterparties")`, `revalidatePath("/compliance")`, `revalidatePath("/audit")`, `revalidatePath("/invoices")`, `revalidatePath("/contractors")` with a single `revalidateOrgPages();` per code path (one call where there were several consecutive). **Keep** `revalidatePath("/")` — the landing page still lives there. Import `revalidateOrgPages` from `@/lib/auth/revalidate`; remove the `revalidatePath` import from any file that no longer uses it.

Run: `grep -rnE "revalidatePath\(\"/(console|audit|compliance|contractors|counterparties|insights|invoices)" src`
Expected: no output.

- [ ] **Step 11: Verify in the running app**

Run: `npm run verify` — expected exit 0.

With the dev server running and **no** session cookie:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/audit?domain=treasury
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/o/founding/console
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s http://localhost:3000/api/ledger/verify
```

Expected, in order: `307 …/o/founding/audit?domain=treasury`; `307 …/login?next=%2Fo%2Ffounding%2Fconsole`; `200`; `{"valid":true,...}`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(auth): organizations in the URL, behind a membership gate

Product pages move under /o/[slug]; the layout verifies the session and
the membership, answering 404 for non-members. Old paths redirect to the
founding organization. Links and revalidation go through orgHref and
revalidateOrgPages.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Only an owner changes anything — the shared-token unlock goes, the ledger learns who

**Files:**
- Create: `src/lib/auth/authorize.ts`
- Modify: `src/app/actions/agent.ts`, `src/app/actions/intake.ts`, `src/app/actions/milestones.ts`, `src/components/AgentControls.tsx`, `src/components/AgentControlsClient.tsx`, `src/components/intake/CounterpartyIntake.tsx`, `src/components/intake/InvoiceIntake.tsx`, `src/components/intake/InvoiceCsvImport.tsx`, `src/components/MilestoneVerification.tsx`, the seven pages under `src/app/o/[slug]/`, `src/lib/agent-security.ts`, `tests/agent-security.test.ts`
- Delete: `src/lib/agent-session.ts`, `src/components/AgentControlsUnlock.tsx`

**Interfaces:**
- Consumes: `getSessionUser`, `SessionUser` (Task 4); `membershipFor`, `OrgMembership` (Task 6); `canMutate` (Task 6)
- Produces:
  - `type Authorization = { ok: true; user: SessionUser; membership: OrgMembership } | { ok: false; message: string }`
  - `authorizeMutation(orgSlug: unknown): Promise<Authorization>`
  - `viewerCanMutate(orgSlug: string): Promise<boolean>`
  - `runAgentCycleAction(orgSlug: string): Promise<AgentActionResult>`
  - `AgentControls` gains required prop `orgSlug: string`; `CounterpartyIntake`, `InvoiceIntake`, `InvoiceCsvImport`, `MilestoneVerification` gain required prop `orgSlug: string`

- [ ] **Step 1: The authorization helper**

`src/lib/auth/authorize.ts`:

```ts
import "server-only";
import { membershipFor, type OrgMembership } from "./membership";
import { canMutate } from "./roles";
import { getSessionUser, type SessionUser } from "./session";

export type Authorization =
  | { ok: true; user: SessionUser; membership: OrgMembership }
  | { ok: false; message: string };

/**
 * For server actions. The slug arrives from the form and is only a claim about
 * which workspace the person means; membership and role are checked here
 * every time.
 */
export async function authorizeMutation(orgSlug: unknown): Promise<Authorization> {
  if (typeof orgSlug !== "string" || !orgSlug) return { ok: false, message: "Missing workspace." };
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const membership = await membershipFor(user.id, orgSlug);
  if (!membership || !canMutate(membership.role)) {
    return { ok: false, message: "Only an owner of this workspace can do that." };
  }
  return { ok: true, user, membership };
}

/** For pages deciding whether to render mutating controls at all. */
export async function viewerCanMutate(orgSlug: string): Promise<boolean> {
  return (await authorizeMutation(orgSlug)).ok;
}
```

- [ ] **Step 2: Agent actions and controls**

`src/app/actions/agent.ts` — delete `unlockAgentControls` and the `agent-session` import. `runAgentCycleAction` becomes:

```ts
export async function runAgentCycleAction(orgSlug: string): Promise<AgentActionResult> {
  const auth = await authorizeMutation(orgSlug);
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    const result = await runAgentCycle();
    revalidateOrgPages();
    return {
      ok: true,
      message: result.clockMode === "simulate"
        ? `Day ${result.day} complete · ${result.lines.length} decisions logged.`
        : `Cycle complete at ${new Date(result.finishedAt).toLocaleString()} · ${result.lines.length} decisions logged.`,
      day: result.day,
      lines: result.lines.length,
    };
  } catch (error) {
    console.error("agent cycle failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "The agent cycle did not complete." };
  }
}
```

Add `import { authorizeMutation } from "@/lib/auth/authorize";`.

`src/components/AgentControls.tsx`:

```tsx
import { viewerCanMutate } from "@/lib/auth/authorize";
import type { CycleClockMode } from "@/lib/clock";
import AgentControlsClient from "./AgentControlsClient";

/** Renders nothing for someone who may not run the agent — no locked button to tempt them. */
export default async function AgentControls({
  orgSlug,
  nextDay,
  headSeq,
  clockMode = "simulate",
}: {
  orgSlug: string;
  nextDay: number;
  headSeq?: number;
  clockMode?: CycleClockMode;
}) {
  if (!(await viewerCanMutate(orgSlug))) return null;
  return <AgentControlsClient orgSlug={orgSlug} nextDay={nextDay} headSeq={headSeq} clockMode={clockMode} />;
}
```

`src/components/AgentControlsClient.tsx` — add `orgSlug: string` to its props and call `runAgentCycleAction(orgSlug)`.

Delete `src/components/AgentControlsUnlock.tsx` and `src/lib/agent-session.ts`.

- [ ] **Step 3: Intake and milestone actions — authorize by workspace, record who**

`src/app/actions/intake.ts`:
1. Delete the `hasAgentControlSession` import, `INITIAL_FAILURE`, and `authorized()`.
2. At the top of `createCounterpartyAction`, `createInvoiceAction`, and `importInvoicesAction`, replace `if (!(await authorized())) return INITIAL_FAILURE;` with:

```ts
  const auth = await authorizeMutation(formData.get("orgSlug"));
  if (!auth.ok) return { ok: false, message: auth.message };
```

3. In each of the three `appendLedgerEntry({ actor: "human", …, detail: { … } })` calls, make `by: auth.user.id` the first key of `detail`:

```ts
      detail: {
        by: auth.user.id,
        // …existing keys unchanged
```

4. Record who created each invoice — migration 0015 added the column so Tier 1 can refuse to let anyone approve what they created, and invoices created from now on must carry it. In `createInvoiceAction`'s `.from("invoices").insert({ … })`, add `created_by: auth.user.id,` to the inserted object. In `importInvoicesAction`'s `.from("invoices").insert(resolved.map(({ row, counterparty }) => ({ … })))`, add `created_by: auth.user.id,` to the object each row maps to.

`src/app/actions/milestones.ts`: the same — replace the `hasAgentControlSession` check with the two `authorizeMutation` lines, and add `by: auth.user.id` as the first key of the one human `detail`. (Milestones are verified here, not created, so `created_by` is not written in this file.)

Import `authorizeMutation` from `@/lib/auth/authorize` in both files.

Run: `grep -nE "actor: \"human\"" -A 6 src/app/actions/*.ts | grep -c "by: auth.user.id"`
Expected: `4`.

Run: `grep -c "created_by: auth.user.id" src/app/actions/intake.ts`
Expected: `2`.

- [ ] **Step 4: Forms carry the workspace**

In `CounterpartyIntake`, `InvoiceIntake`, `InvoiceCsvImport`, `MilestoneVerification`: add `orgSlug: string` to the props, and as the first child of each `<form>`:

```tsx
<input type="hidden" name="orgSlug" value={orgSlug} />
```

(`InvoiceCsvImport` builds `new FormData(event.currentTarget)` from its `<form onSubmit>`, so the hidden input is included there too.)

- [ ] **Step 5: Pages ask the membership, not the cookie**

In `o/[slug]/counterparties`, `o/[slug]/invoices`, `o/[slug]/contractors`: replace `hasAgentControlSession()` in the `Promise.all` with `viewerCanMutate(slug)`, and import it from `@/lib/auth/authorize`. In all seven pages pass `orgSlug={slug}` to `AgentControls`, and to every intake and milestone component. Let the compiler find them:

Run: `npm run typecheck` — fix until clean.

- [ ] **Step 6: Remove the session-cookie proof**

In `src/lib/agent-security.ts` delete `AGENT_SESSION_COOKIE` and `agentSessionProof` (keep `secureTokenMatches`, `bearerToken`, `hasValidAgentBearer`, the reset guard). In `tests/agent-security.test.ts` delete the `agentSessionProof` import and the `it(...)` block that calls it (inside `describe("agent bearer authentication")`).

Run: `grep -rnE "hasAgentControlSession|createAgentControlSession|agentSessionProof|AGENT_SESSION_COOKIE|AgentControlsUnlock|unlockAgentControls" src tests`
Expected: no output.

- [ ] **Step 7: Verify**

Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(auth): only an owner changes anything; the ledger records who

The shared-token unlock and its cookie are gone. Actions authorize the
signed-in user's role in the workspace named by the form; pages render
mutating controls only for an owner. Human ledger entries carry
detail.by = user id, never an email address.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Operator commands — grant a role, adopt env secrets

**Files:**
- Create: `src/lib/platform/adopt.ts`, `scripts/org-grant.ts`, `scripts/org-adopt-env.ts`
- Modify: `package.json` (two scripts)
- Test: `tests/adopt.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret`, `masterKeysFromEnv`, `MasterKey`, `SecretEnvelope` (Task 2); `ledgerKeyId` from `@/lib/ledger-keys`; `isValidSlug` (Task 6); `isOrgRole` (Task 6); `configFromEnv` from `src/lib/config`; `createContext` from `src/lib/context`
- Produces:
  - `interface AdoptedSecrets { ledger_signing_key_enc: SecretEnvelope; circle_api_key_enc: SecretEnvelope | null; circle_entity_secret_enc: SecretEnvelope | null; ledgerKeyId: string }`
  - `adoptEnvSecrets(input: { orgId: string; env: Record<string, string | undefined>; keys: MasterKey[]; expectLedgerKeyId: string }): AdoptedSecrets`
  - `npm run org:grant -- <slug> <email> <role>`, `npm run org:adopt-env -- <slug> --expect-key-id <id>`

- [ ] **Step 1: Write the failing tests**

`tests/adopt.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { adoptEnvSecrets } from "@/lib/platform/adopt";
import { decryptSecret, type MasterKey } from "@/lib/secrets";

const ORG = "00000000-0000-4000-8000-000000000001";
const keys: MasterKey[] = [{ id: "v1", key: crypto.randomBytes(32) }];
const signing = crypto.generateKeyPairSync("ed25519");
const pem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const id = ledgerKeyId(signing.publicKey);
const escaped = pem.trim().split("\n").join("\\n");

describe("adoptEnvSecrets", () => {
  it("encrypts each secret for its own column, and the ledger key decrypts to a usable PEM", () => {
    const adopted = adoptEnvSecrets({
      orgId: ORG,
      env: { LEDGER_SIGNING_KEY: escaped, CIRCLE_API_KEY: "circle-key", CIRCLE_ENTITY_SECRET: "entity-secret" },
      keys,
      expectLedgerKeyId: id,
    });

    expect(adopted.ledgerKeyId).toBe(id);
    const ledger = decryptSecret(adopted.ledger_signing_key_enc, { orgId: ORG, column: "ledger_signing_key_enc" }, keys);
    expect(ledgerKeyId(crypto.createPrivateKey(ledger))).toBe(id);
    expect(decryptSecret(adopted.circle_api_key_enc!, { orgId: ORG, column: "circle_api_key_enc" }, keys)).toBe("circle-key");
    expect(decryptSecret(adopted.circle_entity_secret_enc!, { orgId: ORG, column: "circle_entity_secret_enc" }, keys)).toBe("entity-secret");
  });

  it("refuses a ledger key that is not the one that signed the chain, naming both ids", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const otherId = ledgerKeyId(other.publicKey);

    expect(() => adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: otherPem }, keys, expectLedgerKeyId: id }))
      .toThrow(new RegExp(`${otherId}.*${id}`));
  });

  it("refuses when there is no ledger key to adopt", () => {
    expect(() => adoptEnvSecrets({ orgId: ORG, env: {}, keys, expectLedgerKeyId: id })).toThrow(/LEDGER_SIGNING_KEY/);
  });

  it("leaves absent Circle credentials absent rather than encrypting an empty string", () => {
    const adopted = adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: pem }, keys, expectLedgerKeyId: id });
    expect(adopted.circle_api_key_enc).toBeNull();
    expect(adopted.circle_entity_secret_enc).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/adopt.test.ts`
Expected: FAIL — `Cannot find package '@/lib/platform/adopt'`.

- [ ] **Step 3: Implement**

`src/lib/platform/adopt.ts`:

```ts
import crypto from "node:crypto";
import { ledgerKeyId } from "../ledger-keys";
import { encryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";

export interface AdoptedSecrets {
  ledger_signing_key_enc: SecretEnvelope;
  circle_api_key_enc: SecretEnvelope | null;
  circle_entity_secret_enc: SecretEnvelope | null;
  ledgerKeyId: string;
}

/**
 * Moves an organization's secrets from the platform's environment into its own
 * row, encrypted. Refuses a ledger key that is not the one that signed the
 * chain: storing the wrong key would make every future entry unverifiable
 * against the history, which is the failure the key-custody work exists to
 * prevent.
 */
export function adoptEnvSecrets(input: {
  orgId: string;
  env: Record<string, string | undefined>;
  keys: MasterKey[];
  expectLedgerKeyId: string;
}): AdoptedSecrets {
  const raw = input.env.LEDGER_SIGNING_KEY;
  if (!raw) throw new Error("LEDGER_SIGNING_KEY is not set; there is no ledger key to adopt");
  const pem = raw.split("\\n").join("\n");
  const id = ledgerKeyId(crypto.createPrivateKey(pem));
  if (id !== input.expectLedgerKeyId) {
    throw new Error(
      `LEDGER_SIGNING_KEY is key ${id}, but ${input.expectLedgerKeyId} signed this chain; refusing to store it`
    );
  }

  const seal = (value: string | undefined, column: string): SecretEnvelope | null =>
    value ? encryptSecret(value, { orgId: input.orgId, column }, input.keys) : null;

  return {
    ledger_signing_key_enc: encryptSecret(pem, { orgId: input.orgId, column: "ledger_signing_key_enc" }, input.keys),
    circle_api_key_enc: seal(input.env.CIRCLE_API_KEY, "circle_api_key_enc"),
    circle_entity_secret_enc: seal(input.env.CIRCLE_ENTITY_SECRET, "circle_entity_secret_enc"),
    ledgerKeyId: id,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/adopt.test.ts`
Expected: PASS.

- [ ] **Step 5: The two commands**

`scripts/org-grant.ts`:

```ts
/**
 * Gives a person a role in an organization. For the operator: the founding
 * organization has no owner until this runs.
 *
 *   npm run org:grant -- founding you@example.com owner
 *
 * The person must have signed in once, so that an account exists.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { configFromEnv } = await import("../src/lib/config");
  const { createContext } = await import("../src/lib/context");
  const { isValidSlug } = await import("../src/lib/auth/org-paths");
  const { isOrgRole } = await import("../src/lib/auth/roles");

  const [slug, emailArg, role] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  if (!slug || !isValidSlug(slug) || !email || !isOrgRole(role)) {
    throw new Error("usage: npm run org:grant -- <slug> <email> <owner|admin|approver|viewer>");
  }

  const db = createContext(configFromEnv(process.env)).db;

  const org = await db.from("orgs").select("id, name").eq("slug", slug).maybeSingle();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) throw new Error(`no organization with slug ${slug}`);

  let userId: string | null = null;
  for (let page = 1; !userId; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) userId = match.id;
    if (data.users.length < 200) break;
  }
  if (!userId) throw new Error(`no account for ${email}; sign in once at /login, then run this again`);

  const upsert = await db
    .from("memberships")
    .upsert({ org_id: org.data.id, user_id: userId, role }, { onConflict: "org_id,user_id" });
  if (upsert.error) throw new Error(upsert.error.message);

  console.log(`${email} is now ${role} of ${org.data.name} (${slug}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

`scripts/org-adopt-env.ts`:

```ts
/**
 * Encrypts this deployment's env secrets into an organization's row, then
 * reads them back and re-derives the ledger key id to prove the round trip.
 * Prints ids and presence only — never a secret.
 *
 *   npm run org:adopt-env -- founding --expect-key-id 9b03458d9a617871
 *
 * Does NOT remove anything from env: the app reads env secrets until Plan 2.
 */
import crypto from "node:crypto";
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { configFromEnv } = await import("../src/lib/config");
  const { createContext } = await import("../src/lib/context");
  const { isValidSlug } = await import("../src/lib/auth/org-paths");
  const { adoptEnvSecrets } = await import("../src/lib/platform/adopt");
  const { decryptSecret, masterKeysFromEnv } = await import("../src/lib/secrets");
  const { ledgerKeyId } = await import("../src/lib/ledger-keys");

  const args = process.argv.slice(2);
  const slug = args[0];
  const flag = args.indexOf("--expect-key-id");
  const expected = flag >= 0 ? args[flag + 1] : undefined;
  if (!slug || !isValidSlug(slug) || !expected) {
    throw new Error("usage: npm run org:adopt-env -- <slug> --expect-key-id <16 hex>");
  }

  const db = createContext(configFromEnv(process.env)).db;
  const org = await db.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) throw new Error(`no organization with slug ${slug}`);

  const keys = masterKeysFromEnv();
  const adopted = adoptEnvSecrets({ orgId: org.data.id, env: process.env, keys, expectLedgerKeyId: expected });

  const update = await db
    .from("orgs")
    .update({
      ledger_signing_key_enc: adopted.ledger_signing_key_enc,
      circle_api_key_enc: adopted.circle_api_key_enc,
      circle_entity_secret_enc: adopted.circle_entity_secret_enc,
    })
    .eq("id", org.data.id);
  if (update.error) throw new Error(update.error.message);

  const stored = await db.from("orgs").select("ledger_signing_key_enc").eq("id", org.data.id).single();
  if (stored.error) throw new Error(stored.error.message);
  const pem = decryptSecret(stored.data.ledger_signing_key_enc, { orgId: org.data.id, column: "ledger_signing_key_enc" }, keys);
  const roundTrip = ledgerKeyId(crypto.createPrivateKey(pem));
  if (roundTrip !== expected) throw new Error(`stored key re-derives to ${roundTrip}, not ${expected}`);

  console.log(`ledger key ${roundTrip} stored for ${slug} under master key ${keys[0].id}, and re-derived from the database.`);
  console.log(`circle api key: ${adopted.circle_api_key_enc ? "stored" : "absent"} · entity secret: ${adopted.circle_entity_secret_enc ? "stored" : "absent"}`);
  console.log("Env copies are still in use by the app. Do not remove them until Plan 2 switches reads to the database.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

In `package.json` `scripts`, add after `"fixture:guardrail"`:

```json
    "org:grant": "tsx scripts/org-grant.ts",
    "org:adopt-env": "tsx scripts/org-adopt-env.ts"
```

- [ ] **Step 6: Verify**

Run: `npm run verify` — expected exit 0.
Run: `npm run org:grant` — expected: the usage line, exit 1 (no database write).
Run: `npm run org:adopt-env -- founding` — expected: the usage line (missing `--expect-key-id`), exit 1.

- [ ] **Step 7: Commit**

```bash
git add src/lib/platform/adopt.ts scripts/org-grant.ts scripts/org-adopt-env.ts package.json tests/adopt.test.ts
git commit -m "feat(platform): grant a role, and adopt env secrets into an organization

org:adopt-env refuses any ledger key but the one that signed the chain,
then proves the stored key re-derives the same id. It removes nothing
from env; the app reads env secrets until Plan 2.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Ship and measure

Operator steps are marked **[partner]** — they involve secrets or dashboards the agent does not touch.

**Files:** none changed; this task opens the pull request and verifies production.

- [ ] **Step 1: [partner] Create the master key**

Run: `node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"`
Add the printed line as `VESTIARION_MASTER_KEYS=` to `.env.local`, and to Vercel (Production, **Sensitive**). Keep a copy somewhere safe: losing it makes every stored organization secret unreadable.

- [ ] **Step 2: [partner] Check Vercel has the public auth settings**

Vercel must have `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for Production. They are inlined at build time, so they must exist before the deploy.

- [ ] **Step 3: [partner] Configure Supabase Auth**

Dashboard → *Authentication → URL Configuration*:
- Site URL: `https://vestiarion.vercel.app`
- Redirect URLs: `https://vestiarion.vercel.app/auth/callback`, `http://localhost:3000/auth/callback`

Optional: enable the Google provider, then set `AUTH_GOOGLE_ENABLED=true` on Vercel.

- [ ] **Step 4: Open the pull request**

Push the branch and open a PR titled `feat(auth): accounts and a founding organization (identity & tenancy, plan 1)`. Wait for `verify` and the Vercel build to pass.

- [ ] **Step 5: Apply 0015 before deploying**

Run: `npm run db:migrate`
Expected: every file prints `ok`, including `0015_tenancy.sql`. (The idempotency test in Task 3 is what makes re-running the earlier fourteen safe.)

- [ ] **Step 6: [partner] Merge**

Only on the partner's explicit instruction for this PR.

- [ ] **Step 7: [partner] Sign in, and become the founding owner**

Sign in at `https://vestiarion.vercel.app/login` with the operator's email. Expect `/onboarding` to say "No workspace yet". Then:

Run: `npm run org:grant -- founding <operator email> owner`
Expected: `<email> is now owner of Vestiarion workspace (founding).`

Reload `/onboarding` — expect a redirect to `/o/founding/console`.

- [ ] **Step 8: Adopt the env secrets**

Run: `npm run org:adopt-env -- founding --expect-key-id 9b03458d9a617871`
Expected: `ledger key 9b03458d9a617871 stored for founding …, and re-derived from the database.` Leave every env secret in place.

- [ ] **Step 9: Measure production**

```bash
U=https://vestiarion.vercel.app
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$U/console"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$U/o/founding/console"
curl -s "$U/api/ledger/verify"
```

Expected: `307 …/o/founding/console`; `307 …/login?next=%2Fo%2Ffounding%2Fconsole` (signed out); `{"valid":true,"checkedEntries":N}` with N ≥ 114.

Signed in as the owner, in a browser: `/o/founding/audit` lists the entries and the verify badge reads "Chain intact"; the Run-cycle control is present.

**[partner]** Sign in with a second account that is not a member: `/o/founding/console` must answer 404.

Run: `gh workflow run agent-cycle.yml` and wait for success; `/api/ledger/verify` must then report more entries than before, still `valid: true`.

- [ ] **Step 10: Record the outcome**

Add to the spec's §10 step 2 a line: `Shipped <date> as #<PR>; measured: <the four results above>.` Commit on `main` after the merge is deployed.
