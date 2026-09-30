# Audit Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member downloads their workspace's signed ledger as JSON (verifiable) or CSV, and checks the JSON with a standalone Node.js script that shares no code with the app.

**Architecture:** A paged `readLedgerRows()` feeds both `verifyLedger()` and `buildLedgerExport()` (src/lib/ledger-export.ts). A session-authenticated route `GET /api/ledger/export` streams the file and appends `system/ledger_exported`. `public/tools/verify-ledger-export.mjs` re-implements the chain rules with `node:crypto` only, and a test runs it as a child process against exports built from test-signed chains, requiring the same verdict as `verifyChain`.

**Tech Stack:** Next.js 16 route handlers (streamed `Response`), supabase-js via the tenant `db()`, Node `crypto` Ed25519, Vitest (+ `tests/support/fake-supabase.ts`), MDX docs.

**Spec:** `docs/superpowers/specs/2026-09-30-audit-export-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md) — for the route handler: `01-app/03-api-reference/03-file-conventions/route.md` and `01-app/02-guides/streaming.md`.
- Export format id: exactly `vestiarion-ledger-export/1`.
- Entry fields, in this order, unchanged from the row: `seq, id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash, signing_key_id`.
- Filename: `vestiarion-<slug>-ledger-<headSeq>.json` / `.csv` (`headSeq` 0 for an empty chain).
- Route: `GET /api/ledger/export?org=<slug>&format=json|csv`; 401 `{ error: "Sign in to export this ledger." }` signed out, 404 `{ error: "Not found" }` for a non-member, 400 `{ error: "format must be json or csv" }`, 500 `{ error: "The ledger could not be exported." }`.
- Verifier exit codes: 0 valid, 1 broken, 2 could not check. Its first output line starts with `VALID`, `BROKEN` or `NOT CHECKED`.
- CSV formula guard: a cell whose first character is one of `= + - @ \t \r` is prefixed with `'`.
- Ledger action `system/ledger_exported`, `actor: "human"`, detail exactly `{ by, format, entries, headSeq }` — ids and counts only.
- No `/api/v1` change; no changelog entry (spec E7).
- Product copy names "Arc testnet" plainly where it names a network; no disclaimers.
- Every UI control uses `src/components/ui/*` primitives (`tests/ui-consistency.test.ts`).
- Commit messages are neutral project history and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Subagents never touch production; no network calls in tests.

## Review Focus

1. **A chain longer than one PostgREST page** — `verifyLedger()` and the export must see every entry, not the first 1,000. Expect paging by `seq` until a short page (Task 1 pins three pages).
2. **A summary that starts with `=`** (a counterparty named `=HYPERLINK(...)`) — the CSV must not become a formula (Task 2 pins every dangerous first character, and that JSON is untouched).
3. **A tampered file that also swaps its keys** — the verifier trusts the file's keys by default, so it must print the key ids and head hash to compare, and `--public-key` must reject a file signed by another key (Task 3 pins both).
4. **The verifier and the app disagreeing** — detail changed, signature swapped, entry removed, entries reordered, unknown key label: the script's exit code must map to `verifyChain`'s `true / false / null` on the same rows (Task 3).
5. **The audit note failing** — `ledger_exported` cannot be appended (database hiccup): the download must still answer 200 (Task 4).

---

### Task 1: Paged ledger reads, and shared chain-building test helpers

**Files:**
- Modify: `src/lib/ledger.ts` (add `readLedgerRows`; `verifyLedger` uses it)
- Create: `tests/support/ledger-chain.ts` (move `buildChain`, `continueChain`, `GENESIS` out of `tests/ledger.test.ts`)
- Modify: `tests/ledger.test.ts` (import them from the support file instead)
- Test: `tests/ledger-paging.test.ts`

**Interfaces:**
- Produces:
  - `export const LEDGER_PAGE_SIZE = 1000;` in src/lib/ledger.ts
  - `export async function readLedgerRows(): Promise<LedgerRow[]>` — every row of the organization in scope, oldest first
  - `tests/support/ledger-chain.ts`: `export const GENESIS: string`, `export function buildChain(inputs: LedgerEntryInput[], privateKey: crypto.KeyObject, signingKeyId?: string): LedgerRow[]`, `export function continueChain(existing: LedgerRow[], inputs: LedgerEntryInput[], privateKey: crypto.KeyObject, signingKeyId?: string): LedgerRow[]`

- [ ] **Step 1: Move the helpers.** Cut `GENESIS`, `buildChain` and `continueChain` (with their doc comments, unchanged) from `tests/ledger.test.ts` into `tests/support/ledger-chain.ts`, exporting each, with the imports they need (`node:crypto`, `bodyHashOf`, `LedgerEntryInput`, `LedgerRow` from `@/lib/ledger`). In `tests/ledger.test.ts` import them from `./support/ledger-chain`. Run `npx vitest run tests/ledger.test.ts` — expected PASS, same count as before.

- [ ] **Step 2: Write the failing test**

```ts
// tests/ledger-paging.test.ts
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { LEDGER_PAGE_SIZE, readLedgerRows, verifyLedger, type LedgerEntryInput } from "@/lib/ledger";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { buildChain } from "./support/ledger-chain";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * PostgREST answers at most `max_rows` (1,000 on Supabase) per request, so a
 * chain read in one request silently stops at its first page. The ledger is
 * read by seq in pages until a page comes back short (audit-export spec E3).
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e0e0";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const LEDGER_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const saved = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = saved;
});

const inputs = (n: number): LedgerEntryInput[] =>
  Array.from({ length: n }, (_, i) => ({ actor: "agent", domain: "ap", action: "ap_pay", summary: `entry ${i + 1}`, detail: { i } }));

function ledgerFake(rows: ReturnType<typeof buildChain>) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", wallet_host: null,
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/ledger_entries") {
      // Answer the way PostgREST does: rows after `seq=gt.N`, ascending, at most `limit`.
      const after = Number((request.params.get("seq") ?? "gt.0").replace(/^gt\./, ""));
      const limit = Number(request.params.get("limit") ?? rows.length);
      return { body: rows.filter((row) => row.seq > after).slice(0, limit) };
    }
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

describe("readLedgerRows", () => {
  it("reads every page, by seq, until a page comes back short", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE * 2 + 5), privateKey);
    const { fake, run } = ledgerFake(rows);

    const read = await run(() => readLedgerRows());

    expect(read.map((row) => row.seq)).toEqual(rows.map((row) => row.seq));
    const pages = fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    expect(pages.map((request) => request.params.get("seq"))).toEqual(["gt.0", `gt.${LEDGER_PAGE_SIZE}`, `gt.${LEDGER_PAGE_SIZE * 2}`]);
    for (const page of pages) {
      expect(page.params.get("order")).toBe("seq.asc");
      expect(page.params.get("limit")).toBe(String(LEDGER_PAGE_SIZE));
    }
  });

  it("makes one request for an empty chain", async () => {
    const { fake, run } = ledgerFake([]);
    await expect(run(() => readLedgerRows())).resolves.toEqual([]);
    expect(fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries")).toHaveLength(1);
  });
});

describe("verifyLedger", () => {
  it("checks entries past the first page", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE + 3), privateKey);
    const { run } = ledgerFake(rows);
    await expect(run(() => verifyLedger())).resolves.toMatchObject({ valid: true, checkedEntries: LEDGER_PAGE_SIZE + 3 });
  });

  it("finds a break on the second page", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE + 3), privateKey);
    rows[LEDGER_PAGE_SIZE + 1] = { ...rows[LEDGER_PAGE_SIZE + 1], summary: "rewritten" };
    const { run } = ledgerFake(rows);
    await expect(run(() => verifyLedger())).resolves.toMatchObject({ valid: false, brokenAt: LEDGER_PAGE_SIZE + 2 });
  });
});
```

If the org-row fake needs more columns for `withOrg` (compare `tests/counterparty-limit.test.ts`), add them; if appends of a rotation check read `ledger_entries` with other params, keep the fake's branch answering by `seq`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/ledger-paging.test.ts`
Expected: FAIL — `LEDGER_PAGE_SIZE` / `readLedgerRows` not exported.

- [ ] **Step 4: Implement** in `src/lib/ledger.ts`, just above `verifyLedger`:

```ts
/** PostgREST's `max_rows` on Supabase: the most rows one request answers with. */
export const LEDGER_PAGE_SIZE = 1000;

/**
 * Every entry of the organization in scope, oldest first. Read by `seq` in
 * pages, because one request stops at the project's row cap and a chain past
 * it would otherwise verify, or export, only its first page (audit-export E3).
 */
export async function readLedgerRows(): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let after = 0;
  for (;;) {
    const page = unwrap(
      await db()
        .from("ledger_entries")
        .select("*")
        .gt("seq", after)
        .order("seq", { ascending: true })
        .limit(LEDGER_PAGE_SIZE)
    ) as LedgerRow[];
    rows.push(...page);
    if (page.length < LEDGER_PAGE_SIZE) return rows;
    after = page[page.length - 1].seq;
  }
}
```

and make `verifyLedger` read through it:

```ts
/** Verifies the ledger as stored in Postgres, oldest entry first. */
export async function verifyLedger(): Promise<VerificationResult> {
  return verifyChain(await readLedgerRows(), ledgerVerificationKeyring());
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/ledger-paging.test.ts tests/ledger.test.ts tests/verify-ledger.test.tsx tests/ledger-parity.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ledger.ts tests/support/ledger-chain.ts tests/ledger.test.ts tests/ledger-paging.test.ts
git commit -m "Read the ledger in pages so long chains verify whole"
```

---

### Task 2: `src/lib/ledger-export.ts` — the export document and its CSV

**Files:**
- Create: `src/lib/ledger-export.ts`
- Test: `tests/ledger-export.test.ts`

**Interfaces:**
- Consumes: `readLedgerRows()`, `verifyChain()`, `ledgerVerificationKeyring()`, `canonicalJson()`, `LedgerRow`, `VerificationResult` from `src/lib/ledger.ts`; `ledgerKeyId()` and `LedgerKeyring` from `src/lib/ledger-keys.ts`.
- Produces:
  - `export const LEDGER_EXPORT_FORMAT = "vestiarion-ledger-export/1";`
  - `export const LEDGER_EXPORT_FIELDS = ["seq","id","ts","actor","domain","action","summary","detail","body_hash","signature","prev_hash","hash","signing_key_id"] as const;`
  - `export interface LedgerExportKey { id: string; status: "active" | "retired"; publicKeyPem: string }`
  - `export interface LedgerExport { format: typeof LEDGER_EXPORT_FORMAT; exportedAt: string; workspace: { slug: string; name: string }; head: { seq: number; hash: string } | null; keys: LedgerExportKey[]; verification: VerificationResult; entries: Array<Record<(typeof LEDGER_EXPORT_FIELDS)[number], unknown>> }`
  - `export function exportFromRows(input: { rows: LedgerRow[]; keyring: LedgerKeyring; workspace: { slug: string; name: string }; now: Date }): LedgerExport` (pure)
  - `export async function buildLedgerExport(workspace: { slug: string; name: string }, now?: Date): Promise<LedgerExport>` (in scope; reads and verifies)
  - `export function exportKeys(keyring: LedgerKeyring): LedgerExportKey[]`
  - `export function* ledgerExportJsonChunks(doc: LedgerExport, entriesPerChunk?: number): Generator<string>` — concatenated, the chunks are `JSON.stringify(doc)`-equivalent valid JSON with the keys in the interface's order
  - `export function csvCell(value: unknown): string`
  - `export function* ledgerExportCsvChunks(doc: LedgerExport, entriesPerChunk?: number): Generator<string>`
  - `export function exportFileName(slug: string, headSeq: number, format: "json" | "csv"): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ledger-export.test.ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, verifyChain, type LedgerEntryInput } from "@/lib/ledger";
import {
  csvCell,
  exportFileName,
  exportFromRows,
  exportKeys,
  LEDGER_EXPORT_FIELDS,
  LEDGER_EXPORT_FORMAT,
  ledgerExportCsvChunks,
  ledgerExportJsonChunks,
} from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const WORKSPACE = { slug: "northstar", name: "Northstar Studio" };
const current = crypto.generateKeyPairSync("ed25519");
const old = crypto.generateKeyPairSync("ed25519");
const ring = (active: crypto.KeyObject | null, ...retired: crypto.KeyObject[]): LedgerKeyring => ({ active, retired });

const INPUTS: LedgerEntryInput[] = [
  { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY invoice from Northwind Hosting for 240 USDC", detail: { amount: 240, decision: { action: "pay" } } },
  { actor: "human", domain: "compliance", action: "counterparty_limit_changed", summary: '=HYPERLINK("http://x","click"), "quoted", comma\nnewline', detail: { by: "u1", from: 2, to: 10 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "Agent cycle complete", detail: { decisionCount: 1 } },
];

describe("exportFromRows", () => {
  const rows = buildChain(INPUTS, current.privateKey, ledgerKeyId(current.publicKey));
  const doc = exportFromRows({ rows, keyring: ring(current.publicKey, old.publicKey), workspace: WORKSPACE, now: NOW });

  it("names its format, the workspace, the time, and the head", () => {
    expect(doc.format).toBe(LEDGER_EXPORT_FORMAT);
    expect(doc.format).toBe("vestiarion-ledger-export/1");
    expect(doc.workspace).toEqual(WORKSPACE);
    expect(doc.exportedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(doc.head).toEqual({ seq: rows[2].seq, hash: rows[2].hash });
  });

  it("carries every chain field of every entry, oldest first, unchanged", () => {
    expect(doc.entries.map((entry) => Object.keys(entry))).toEqual(rows.map(() => [...LEDGER_EXPORT_FIELDS]));
    doc.entries.forEach((entry, i) => {
      for (const field of LEDGER_EXPORT_FIELDS) expect(entry[field]).toEqual((rows[i] as Record<string, unknown>)[field]);
    });
  });

  it("lists the active key and every retired one, with ids and public PEMs only", () => {
    expect(doc.keys).toEqual([
      { id: ledgerKeyId(current.publicKey), status: "active", publicKeyPem: current.publicKey.export({ type: "spki", format: "pem" }).toString() },
      { id: ledgerKeyId(old.publicKey), status: "retired", publicKeyPem: old.publicKey.export({ type: "spki", format: "pem" }).toString() },
    ]);
    expect(JSON.stringify(doc)).not.toContain("PRIVATE KEY");
  });

  it("records what verifyChain says about exactly these entries", () => {
    expect(doc.verification).toEqual(verifyChain(rows, ring(current.publicKey, old.publicKey)));
    expect(doc.verification.valid).toBe(true);
  });

  it("has no head for an empty chain", () => {
    expect(exportFromRows({ rows: [], keyring: ring(current.publicKey), workspace: WORKSPACE, now: NOW }).head).toBeNull();
  });

  it("exports an active key only once when it is also listed as retired", () => {
    expect(exportKeys(ring(current.publicKey, current.publicKey)).map((key) => key.status)).toEqual(["active"]);
  });
});

describe("ledgerExportJsonChunks", () => {
  it("streams, in small chunks, exactly the document", () => {
    const rows = buildChain(INPUTS, current.privateKey);
    const doc = exportFromRows({ rows, keyring: ring(current.publicKey), workspace: WORKSPACE, now: NOW });
    const chunks = [...ledgerExportJsonChunks(doc, 2)];
    expect(chunks.length).toBeGreaterThan(2);
    expect(JSON.parse(chunks.join(""))).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(Object.keys(JSON.parse(chunks.join("")))).toEqual(["format", "exportedAt", "workspace", "head", "keys", "verification", "entries"]);
  });

  it("is valid JSON for an empty chain", () => {
    const doc = exportFromRows({ rows: [], keyring: ring(current.publicKey), workspace: WORKSPACE, now: NOW });
    expect(JSON.parse([...ledgerExportJsonChunks(doc)].join("")).entries).toEqual([]);
  });
});

describe("csvCell", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("neutralises a formula start: %j", (value) => {
    expect(csvCell(value).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  });

  it("quotes commas, quotes and newlines, doubling quotes", () => {
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
  });

  it("writes null as empty and numbers as they are", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });
});

describe("ledgerExportCsvChunks", () => {
  const rows = buildChain(INPUTS, current.privateKey);
  const doc = exportFromRows({ rows, keyring: ring(current.publicKey), workspace: WORKSPACE, now: NOW });
  const csv = [...ledgerExportCsvChunks(doc, 1)].join("");

  it("has the chain fields as its header and one row per entry, oldest first", () => {
    const [header] = csv.split("\r\n");
    expect(header).toBe(LEDGER_EXPORT_FIELDS.join(","));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.indexOf("Northwind")).toBeLessThan(csv.indexOf("cycle complete"));
  });

  it("writes detail as canonical JSON", () => {
    expect(csv).toContain(csvCell(canonicalJson(INPUTS[0].detail)));
  });

  it("neutralises the formula in a summary, while the JSON export keeps it verbatim", () => {
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click""), ""quoted"", comma\nnewline"`);
    expect(doc.entries[1].summary).toBe(INPUTS[1].summary);
  });
});

describe("exportFileName", () => {
  it("names the workspace, the head and the format", () => {
    expect(exportFileName("northstar", 392, "json")).toBe("vestiarion-northstar-ledger-392.json");
    expect(exportFileName("northstar", 0, "csv")).toBe("vestiarion-northstar-ledger-0.csv");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/ledger-export.test.ts`
Expected: FAIL — cannot resolve `@/lib/ledger-export`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/ledger-export.ts
import {
  canonicalJson,
  ledgerVerificationKeyring,
  readLedgerRows,
  verifyChain,
  type LedgerRow,
  type VerificationResult,
} from "./ledger";
import { ledgerKeyId, type LedgerKeyring } from "./ledger-keys";

/**
 * The audit export (docs/superpowers/specs/2026-09-30-audit-export-design.md):
 * one workspace's whole chain, oldest first, with the public keys that vouch
 * for it and what this server's own verifier said. The JSON is what verifies —
 * `public/tools/verify-ledger-export.mjs` checks it with nothing of ours — and
 * the CSV is for reading in a spreadsheet.
 */

export const LEDGER_EXPORT_FORMAT = "vestiarion-ledger-export/1";

/** The fields a chain is built from, in the order an export writes them. */
export const LEDGER_EXPORT_FIELDS = [
  "seq",
  "id",
  "ts",
  "actor",
  "domain",
  "action",
  "summary",
  "detail",
  "body_hash",
  "signature",
  "prev_hash",
  "hash",
  "signing_key_id",
] as const;

type ExportField = (typeof LEDGER_EXPORT_FIELDS)[number];

export interface LedgerExportKey {
  id: string;
  status: "active" | "retired";
  publicKeyPem: string;
}

export interface LedgerExport {
  format: typeof LEDGER_EXPORT_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  head: { seq: number; hash: string } | null;
  keys: LedgerExportKey[];
  verification: VerificationResult;
  entries: Array<Record<ExportField, unknown>>;
}

const pem = (key: import("node:crypto").KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

/** The public keys a workspace accepts, each once: the active one first, then the retired ones. */
export function exportKeys(keyring: LedgerKeyring): LedgerExportKey[] {
  const keys: LedgerExportKey[] = [];
  const seen = new Set<string>();
  const add = (key: import("node:crypto").KeyObject, status: LedgerExportKey["status"]) => {
    const id = ledgerKeyId(key);
    if (seen.has(id)) return;
    seen.add(id);
    keys.push({ id, status, publicKeyPem: pem(key) });
  };
  if (keyring.active) add(keyring.active, "active");
  for (const key of keyring.retired) add(key, "retired");
  return keys;
}

export function exportFromRows(input: {
  rows: LedgerRow[];
  keyring: LedgerKeyring;
  workspace: { slug: string; name: string };
  now: Date;
}): LedgerExport {
  const last = input.rows[input.rows.length - 1];
  return {
    format: LEDGER_EXPORT_FORMAT,
    exportedAt: input.now.toISOString(),
    workspace: { slug: input.workspace.slug, name: input.workspace.name },
    head: last ? { seq: last.seq, hash: last.hash } : null,
    keys: exportKeys(input.keyring),
    verification: verifyChain(input.rows, input.keyring),
    entries: input.rows.map((row) => {
      const entry = {} as Record<ExportField, unknown>;
      for (const field of LEDGER_EXPORT_FIELDS) entry[field] = (row as unknown as Record<string, unknown>)[field] ?? null;
      return entry;
    }),
  };
}

/** The export of the workspace in scope, read whole and verified here first. */
export async function buildLedgerExport(workspace: { slug: string; name: string }, now = new Date()): Promise<LedgerExport> {
  return exportFromRows({ rows: await readLedgerRows(), keyring: ledgerVerificationKeyring(), workspace, now });
}

const CHUNK = 500;

/** The document as JSON text in chunks of entries, so a long chain is never one string (E4). */
export function* ledgerExportJsonChunks(doc: LedgerExport, entriesPerChunk = CHUNK): Generator<string> {
  const { entries, ...header } = doc;
  const head = JSON.stringify(header);
  yield `${head.slice(0, -1)},"entries":[`;
  for (let i = 0; i < entries.length; i += entriesPerChunk) {
    const part = entries.slice(i, i + entriesPerChunk).map((entry) => JSON.stringify(entry)).join(",");
    yield i === 0 ? part : `,${part}`;
  }
  yield "]}";
}

/** A spreadsheet runs a cell that starts like a formula; these first characters are neutralised with `'`. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : typeof value === "object" ? canonicalJson(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text.startsWith("'") ? `"${text.replace(/"/g, '""')}"` : text;
}

export function* ledgerExportCsvChunks(doc: LedgerExport, entriesPerChunk = CHUNK): Generator<string> {
  yield `${LEDGER_EXPORT_FIELDS.join(",")}\r\n`;
  for (let i = 0; i < doc.entries.length; i += entriesPerChunk) {
    yield doc.entries
      .slice(i, i + entriesPerChunk)
      .map((entry) => `${LEDGER_EXPORT_FIELDS.map((field) => csvCell(entry[field])).join(",")}\r\n`)
      .join("");
  }
}

export function exportFileName(slug: string, headSeq: number, format: "json" | "csv"): string {
  return `vestiarion-${slug}-ledger-${headSeq}.${format}`;
}
```

Note: the `csvCell` quoting rule quotes a neutralised cell too, so a `'`-prefixed value always appears as `"'…"` — the tests assume this.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/ledger-export.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger-export.ts tests/ledger-export.test.ts
git commit -m "Build a workspace's ledger export as JSON and CSV"
```

---

### Task 3: The standalone verifier, held to `verifyChain`

**Files:**
- Create: `public/tools/verify-ledger-export.mjs`
- Test: `tests/ledger-export-verifier.test.ts`

**Interfaces:**
- Consumes: `exportFromRows`, `ledgerExportJsonChunks` (Task 2) and `buildChain` (Task 1) — tests only. The script imports nothing from the app.
- Produces: the CLI `node verify-ledger-export.mjs <file.json> [--public-key <file.pem>]`; exit 0 / 1 / 2; first line `VALID …` / `BROKEN …` / `NOT CHECKED …`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ledger-export-verifier.test.ts
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { exportFromRows, ledgerExportJsonChunks } from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";

/**
 * `public/tools/verify-ledger-export.mjs` is a second implementation of the
 * chain rules on purpose (audit-export E1): someone who does not trust the app
 * cannot be asked to trust a verifier inside it. This test keeps the two in
 * step: for each case the script's exit code must match `verifyChain`'s
 * verdict on the same rows (0 ↔ true, 1 ↔ false, 2 ↔ null).
 */

const SCRIPT = path.join(process.cwd(), "public", "tools", "verify-ledger-export.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "ledger-export-"));
const signer = crypto.generateKeyPairSync("ed25519");
const stranger = crypto.generateKeyPairSync("ed25519");
const KEY_ID = ledgerKeyId(signer.publicKey);
const ring: LedgerKeyring = { active: signer.publicKey, retired: [] };

const INPUTS: LedgerEntryInput[] = [
  { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY 240", detail: { amount: 240, nested: { b: 2, a: [1, { y: 1, x: 2 }] } } },
  { actor: "agent", domain: "ap", action: "ap_hold", summary: "HOLD 1200", detail: { amount: 1200.5 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "done — ünïcode ✓", detail: { decisionCount: 2, empty: {}, list: [] } },
];

let n = 0;
function run(rows: LedgerRow[], extra: string[] = [], keyring: LedgerKeyring = ring, mutate?: (doc: Record<string, unknown>) => void) {
  const doc = exportFromRows({ rows, keyring, workspace: { slug: "northstar", name: "Northstar" }, now: new Date("2026-09-30T00:00:00Z") });
  const parsed = JSON.parse([...ledgerExportJsonChunks(doc)].join(""));
  mutate?.(parsed);
  const file = path.join(dir, `export-${++n}.json`);
  writeFileSync(file, JSON.stringify(parsed));
  const result = spawnSync(process.execPath, [SCRIPT, file, ...extra], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, first: result.stdout.split("\n")[0] };
}

const expected = (rows: LedgerRow[], keyring: LedgerKeyring = ring) => {
  const verdict = verifyChain(rows, keyring).valid;
  return verdict === true ? 0 : verdict === false ? 1 : 2;
};

const intact = () => buildChain(INPUTS, signer.privateKey, KEY_ID);

describe("verify-ledger-export.mjs", () => {
  it("answers VALID for an intact export, naming the key id and head hash to compare", () => {
    const rows = intact();
    const result = run(rows);
    expect(result.code).toBe(0);
    expect(result.code).toBe(expected(rows));
    expect(result.first).toMatch(/^VALID/);
    expect(result.out).toContain(KEY_ID);
    expect(result.out).toContain(rows[2].hash);
    expect(result.out).toMatch(/Audit page/);
  });

  it("verifies unlabelled entries written before key ids existed", () => {
    const rows = buildChain(INPUTS, signer.privateKey);
    expect(run(rows).code).toBe(expected(rows));
  });

  it.each([
    ["detail changed", (rows: LedgerRow[]) => { rows[1] = { ...rows[1], detail: { amount: 12000.5 } }; }],
    ["summary changed", (rows: LedgerRow[]) => { rows[0] = { ...rows[0], summary: "PAY 2400" }; }],
    ["signature swapped", (rows: LedgerRow[]) => { rows[1] = { ...rows[1], signature: rows[0].signature }; }],
    ["entry removed", (rows: LedgerRow[]) => { rows.splice(1, 1); }],
    ["entries reordered", (rows: LedgerRow[]) => { [rows[0], rows[1]] = [rows[1], rows[0]]; }],
    ["hash rewritten", (rows: LedgerRow[]) => { rows[2] = { ...rows[2], hash: "f".repeat(64) }; }],
  ])("answers BROKEN (exit 1) when the %s, as verifyChain does", (_name, tamper) => {
    const rows = intact();
    tamper(rows);
    const result = run(rows);
    expect(expected(rows)).toBe(1);
    expect(result.code).toBe(1);
    expect(result.first).toMatch(/^BROKEN/);
    const brokenAt = verifyChain(rows, ring).brokenAt;
    expect(result.out).toContain(`#${brokenAt}`);
  });

  it("answers NOT CHECKED (exit 2) for an entry signed by a key the file does not hold, as verifyChain does", () => {
    const rows = buildChain(INPUTS, signer.privateKey, "0123456789abcdef");
    const result = run(rows);
    expect(expected(rows)).toBe(2);
    expect(result.code).toBe(2);
    expect(result.first).toMatch(/^NOT CHECKED/);
  });

  it("with --public-key, rejects a file whose signatures and keys were both replaced", () => {
    // A forger re-signs a rewritten chain with their own key and puts that key in the file.
    const forged = buildChain(INPUTS, stranger.privateKey, ledgerKeyId(stranger.publicKey));
    const forgedRing: LedgerKeyring = { active: stranger.publicKey, retired: [] };
    expect(run(forged, [], forgedRing).code).toBe(0); // self-consistent: why the key id must be compared
    const pinned = path.join(dir, "signer.pem");
    writeFileSync(pinned, signer.publicKey.export({ type: "spki", format: "pem" }).toString());
    const result = run(forged, ["--public-key", pinned], forgedRing);
    expect(result.code).toBe(2);
    expect(result.first).toMatch(/^NOT CHECKED/);
  });

  it("with --public-key, accepts the file its key signed", () => {
    const pinned = path.join(dir, "signer-ok.pem");
    writeFileSync(pinned, signer.publicKey.export({ type: "spki", format: "pem" }).toString());
    expect(run(intact(), ["--public-key", pinned]).code).toBe(0);
  });

  it("answers BROKEN when the file's head does not name its last entry", () => {
    const result = run(intact(), [], ring, (doc) => {
      (doc.head as { hash: string }).hash = "e".repeat(64);
    });
    expect(result.code).toBe(1);
  });

  it("answers NOT CHECKED (exit 2) for a file that is not an export", () => {
    const file = path.join(dir, "not-an-export.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }));
    const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  it("verifies an empty chain as VALID with nothing to compare but the key", () => {
    expect(run([]).code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ledger-export-verifier.test.ts`
Expected: FAIL — the script does not exist (exit code not 0).

- [ ] **Step 3: Write the script**

```js
#!/usr/bin/env node
// public/tools/verify-ledger-export.mjs
//
// Checks a Vestiarion audit export (format vestiarion-ledger-export/1) with
// nothing but Node.js: no Vestiarion code, no network. For every entry it
// recomputes the body hash from canonical JSON, checks the Ed25519 signature
// against the key the entry names, and follows the hash links from genesis.
//
//   node verify-ledger-export.mjs export.json [--public-key key.pem]
//
// Exit 0: VALID. Exit 1: BROKEN (the entry and the reason are printed).
// Exit 2: NOT CHECKED (an unknown key, or a file that is not an export).
//
// The file carries its own public keys, so it can only prove it is consistent
// with itself. Compare the key id and head hash printed below with the ones on
// the workspace's Audit page, or pass --public-key with the key you trust.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const GENESIS = "0".repeat(64);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function finish(code, first, ...rest) {
  out(first);
  for (const line of rest) out(line);
  process.exit(code);
}

// The same canonical form the ledger signs: object keys sorted, no whitespace,
// undefined members dropped, arrays in order.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const members = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${members.join(",")}}`;
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// First 16 hex characters of sha256 over the key's SPKI DER form.
function keyId(key) {
  return crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

const args = process.argv.slice(2);
const pinIndex = args.indexOf("--public-key");
const pinPath = pinIndex >= 0 ? args[pinIndex + 1] : undefined;
const file = args.find((arg, i) => !arg.startsWith("--") && i !== pinIndex + 1);
if (!file || (pinIndex >= 0 && !pinPath)) {
  finish(2, "NOT CHECKED: usage: node verify-ledger-export.mjs <export.json> [--public-key <key.pem>]");
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  finish(2, `NOT CHECKED: ${file} could not be read as JSON (${error.message})`);
}
if (doc?.format !== "vestiarion-ledger-export/1" || !Array.isArray(doc.entries) || !Array.isArray(doc.keys)) {
  finish(2, `NOT CHECKED: ${file} is not a Vestiarion ledger export (format vestiarion-ledger-export/1)`);
}

const known = new Map();
try {
  if (pinPath) {
    const key = crypto.createPublicKey(readFileSync(pinPath, "utf8"));
    known.set(keyId(key), key);
  } else {
    for (const entry of doc.keys) {
      const key = crypto.createPublicKey(entry.publicKeyPem);
      known.set(keyId(key), key);
    }
  }
} catch (error) {
  finish(2, `NOT CHECKED: a public key could not be read (${error.message})`);
}
if (known.size === 0) finish(2, "NOT CHECKED: no public key to check the signatures with");

const trusted = [...known.keys()].join(", ");
let expectedPrev = GENESIS;

for (const entry of doc.entries) {
  const at = `entry #${entry.seq}`;
  const bodyHash = sha256(
    canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail })
  );
  if (bodyHash !== entry.body_hash) finish(1, `BROKEN at ${at}: its content does not match its recorded body hash`);

  let candidates;
  if (entry.signing_key_id) {
    const key = known.get(entry.signing_key_id);
    if (!key) {
      finish(2, `NOT CHECKED: ${at} was signed by key ${entry.signing_key_id}, which is not among the trusted keys (${trusted})`);
    }
    candidates = [key];
  } else {
    // Entries written before key ids existed name no key; any trusted key may have signed them.
    candidates = [...known.values()];
  }
  const signed = candidates.some((key) =>
    crypto.verify(null, Buffer.from(entry.body_hash, "hex"), key, Buffer.from(entry.signature, "hex"))
  );
  if (!signed) finish(1, `BROKEN at ${at}: its signature does not verify against the trusted keys (${trusted})`);

  if (entry.prev_hash !== expectedPrev) finish(1, `BROKEN at ${at}: prev_hash does not match the preceding entry's hash`);
  if (sha256(entry.prev_hash + entry.body_hash + entry.signature) !== entry.hash) {
    finish(1, `BROKEN at ${at}: its hash does not match prev_hash + body_hash + signature`);
  }
  expectedPrev = entry.hash;
}

const last = doc.entries[doc.entries.length - 1];
if (last && (doc.head?.seq !== last.seq || doc.head?.hash !== last.hash)) {
  finish(1, `BROKEN: the file's head does not name its last entry (#${last.seq})`);
}

finish(
  0,
  `VALID: ${doc.entries.length} entries of ${doc.workspace?.slug ?? "this workspace"}, each signed and linked from genesis`,
  `Head: ${last ? `#${last.seq} ${last.hash}` : "none (empty chain)"}`,
  `Trusted key id${known.size === 1 ? "" : "s"}: ${trusted}${pinPath ? " (from --public-key)" : " (from the file itself)"}`,
  pinPath
    ? "The signatures were checked against the key you supplied."
    : "The file vouches for itself: compare this key id and head hash with the workspace's Audit page before relying on it."
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ledger-export-verifier.test.ts`
Expected: PASS. If a case's exit code disagrees with `expected(rows)`, the script has drifted from `verifyChain` — fix the script, never the expectation.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint` (if eslint flags `public/**`, the file follows the repo's rules or `public/tools` is added to the eslint ignore list with a comment — prefer satisfying the rules).

```bash
git add public/tools/verify-ledger-export.mjs tests/ledger-export-verifier.test.ts
git commit -m "Add a standalone verifier for ledger exports"
```

---

### Task 4: `GET /api/ledger/export`

**Files:**
- Create: `src/app/api/ledger/export/route.ts`
- Modify: `tests/auth-routes.test.ts` (add `["/api/ledger/export", false]` to `requiresSession`)
- Test: `tests/ledger-export-route.test.ts`

**Interfaces:**
- Consumes: `getSessionUser()` (src/lib/auth/session.ts), `membershipFor(userId, slug)` (src/lib/auth/membership.ts → `OrgMembership { orgId, slug, name, mode, role }`), `inOrg({ user, membership }, fn)`, `buildLedgerExport`, `ledgerExportJsonChunks`, `ledgerExportCsvChunks`, `exportFileName` (Task 2), `appendLedgerEntryBestEffort(orgId, entry)` (src/lib/ledger-best-effort.ts).
- Produces: the route; `system/ledger_exported` entries.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ledger-export-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e1e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
}));

const { sessionMock, membershipMock, buildMock, appendMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  membershipMock: vi.fn(),
  buildMock: vi.fn(),
  appendMock: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendMock }));
vi.mock("@/lib/ledger-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ledger-export")>();
  return { ...actual, buildLedgerExport: buildMock };
});

import { GET } from "@/app/api/ledger/export/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MEMBERSHIP = { orgId: ORG, slug: "northstar", name: "Northstar Studio", mode: "sandbox" as const, role: "viewer" as const };

const DOC = {
  format: "vestiarion-ledger-export/1",
  exportedAt: "2026-09-30T12:00:00.000Z",
  workspace: { slug: "northstar", name: "Northstar Studio" },
  head: { seq: 392, hash: "a".repeat(64) },
  keys: [],
  verification: { valid: true, checkedEntries: 2 },
  entries: [
    { seq: 391, id: "e1", ts: "t", actor: "human", domain: "ap", action: "approval_paid", summary: "=1+1", detail: { a: 1 }, body_hash: "b", signature: "s", prev_hash: "p", hash: "h", signing_key_id: null },
    { seq: 392, id: "e2", ts: "t", actor: "human", domain: "system", action: "x", summary: "ok", detail: {}, body_hash: "b", signature: "s", prev_hash: "h", hash: "a".repeat(64), signing_key_id: null },
  ],
};

function call(query: string) {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar Studio", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => GET(new Request(`https://www.vestiarion.xyz/api/ledger/export${query}`)));
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: USER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  buildMock.mockResolvedValue(DOC);
  appendMock.mockResolvedValue(undefined);
});

describe("GET /api/ledger/export", () => {
  it("asks a signed-out visitor to sign in, and builds nothing", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to export this ledger." });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a workspace the person is not a member of, without saying whether it exists", async () => {
    membershipMock.mockResolvedValueOnce(null);
    const response = await call("?org=someone-else&format=json");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(membershipMock).toHaveBeenCalledWith(USER, "someone-else");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown format", async () => {
    const response = await call("?org=northstar&format=pdf");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "format must be json or csv" });
  });

  it("sends the signed JSON as an attachment to any member, a viewer included", async () => {
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-northstar-ledger-392.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual(DOC);
    expect(buildMock).toHaveBeenCalledWith({ slug: "northstar", name: "Northstar Studio" });
  });

  it("sends the CSV with its formula guard", async () => {
    const response = await call("?org=northstar&format=csv");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-northstar-ledger-392.csv"');
    expect(await response.text()).toContain(`"'=1+1"`);
  });

  it("defaults to JSON", async () => {
    const response = await call("?org=northstar");
    expect(response.headers.get("content-disposition")).toContain(".json");
  });

  it("records who exported what, with ids and counts only", async () => {
    await call("?org=northstar&format=csv");
    expect(appendMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "ledger_exported",
      summary: "Ledger exported as CSV: 2 entries, up to #392",
      detail: { by: USER, format: "csv", entries: 2, headSeq: 392 },
    });
  });

  it("still sends the file when the record cannot be written", async () => {
    appendMock.mockRejectedValueOnce(new Error("database hiccup"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(200);
    logged.mockRestore();
  });

  it("answers a fixed 500 when the ledger cannot be read", async () => {
    buildMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The ledger could not be exported." });
    logged.mockRestore();
  });
});
```

Add `["/api/ledger/export", false]` beside `["/api/ledger/verify", false]` in `tests/auth-routes.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ledger-export-route.test.ts tests/auth-routes.test.ts`
Expected: FAIL — cannot resolve the route.

- [ ] **Step 3: Write the route**

```ts
// src/app/api/ledger/export/route.ts
import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { appendLedgerEntryBestEffort } from "@/lib/ledger-best-effort";
import { buildLedgerExport, exportFileName, ledgerExportCsvChunks, ledgerExportJsonChunks } from "@/lib/ledger-export";

export const dynamic = "force-dynamic";

/**
 * One workspace's signed ledger as a file (audit-export spec §1), for any of
 * its members: viewers already see every entry on the Audit page (E5). Same
 * session check as /api/ledger/verify, and the same 404 for a non-member, so
 * the route never says whether a workspace exists. The export itself is
 * recorded, best effort (E6).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const format = params.get("format") ?? "json";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to export this ledger." }, { status: 401 });
  if (format !== "json" && format !== "csv") return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = await inOrg({ user, membership }, async () => {
      const built = await buildLedgerExport({ slug: membership.slug, name: membership.name });
      const headSeq = built.head?.seq ?? 0;
      try {
        await appendLedgerEntryBestEffort(membership.orgId, {
          actor: "human",
          domain: "system",
          action: "ledger_exported",
          summary: `Ledger exported as ${format.toUpperCase()}: ${built.entries.length} entries, up to #${headSeq}`,
          detail: { by: user.id, format, entries: built.entries.length, headSeq },
        });
      } catch (error) {
        console.error("ledger export: the export could not be recorded", membership.orgId, error instanceof Error ? error.message : error);
      }
      return built;
    });

    const chunks = format === "json" ? ledgerExportJsonChunks(doc) : ledgerExportCsvChunks(doc);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });
    return new Response(body, {
      headers: {
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(membership.slug, doc.head?.seq ?? 0, format)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("ledger export failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The ledger could not be exported." }, { status: 500 });
  }
}
```

`appendLedgerEntryBestEffort` already swallows and logs its own failures; the extra `try` keeps the download alive even if a future version throws (the test pins that). Slugs are `[a-z0-9-]` (`isValidSlug`), so the filename needs no escaping.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ledger-export-route.test.ts tests/auth-routes.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ledger/export/route.ts tests/ledger-export-route.test.ts tests/auth-routes.test.ts
git commit -m "Serve a workspace's ledger export to its members"
```

---

### Task 5: The Download control on the Audit page

**Files:**
- Create: `src/components/AuditExportMenu.tsx`
- Modify: `src/app/o/[slug]/audit/page.tsx` (render it in the Hash chain card, beside `<VerifyLedgerBadge>`; add a line under the public key)
- Test: `tests/audit-export-ui.test.tsx`

**Interfaces:**
- Consumes: the route from Task 4; `Button` (asChild), `Eyebrow` or plain text; `DropdownMenu` primitives from `src/components/ui/DropdownMenu.tsx` if they fit — otherwise two small `Button asChild` links side by side.
- Produces: `AuditExportMenu({ orgSlug }: { orgSlug: string })` rendering two links: "Signed JSON" → `/api/ledger/export?org=<slug>&format=json`, "CSV" → `/api/ledger/export?org=<slug>&format=csv`, each with the `download` attribute, under a visible label "Download".

- [ ] **Step 1: Write the failing test**

```tsx
// tests/audit-export-ui.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditExportMenu } from "@/components/AuditExportMenu";

describe("AuditExportMenu", () => {
  const markup = renderToStaticMarkup(<AuditExportMenu orgSlug="north-star" />);

  it("offers the signed JSON and the CSV as downloads of this workspace's ledger", () => {
    expect(markup).toContain("Download");
    expect(markup).toContain("Signed JSON");
    expect(markup).toContain("CSV");
    expect(markup).toContain('href="/api/ledger/export?org=north-star&amp;format=json"');
    expect(markup).toContain('href="/api/ledger/export?org=north-star&amp;format=csv"');
    expect(markup.match(/ download=""/g)).toHaveLength(2);
  });

  it("points at the guide for checking the file", () => {
    expect(markup).toContain('href="/docs/guides/audit-export"');
  });
});

describe("the Audit page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "audit", "page.tsx"), "utf8");

  it("renders the control for every member, with no role check", () => {
    expect(page).toContain("<AuditExportMenu orgSlug={slug} />");
    expect(page).not.toMatch(/can\([^)]*\)\s*&&\s*<AuditExportMenu/);
  });

  it("says what the key id and head hash are for", () => {
    expect(page).toContain("Compare this key id and the head hash with the ones a verified export prints.");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/audit-export-ui.test.tsx`
Expected: FAIL — cannot resolve `@/components/AuditExportMenu`.

- [ ] **Step 3: Write the component** (server component — no client state needed):

```tsx
// src/components/AuditExportMenu.tsx
import { Download, FileJson, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * The Audit page's export (audit-export spec §1): the signed JSON that the
 * standalone verifier checks, and a CSV for spreadsheets. Plain links with
 * `download`: the route answers with an attachment, for any member.
 */
export function AuditExportMenu({ orgSlug }: { orgSlug: string }) {
  const href = (format: "json" | "csv") => `/api/ledger/export?org=${encodeURIComponent(orgSlug)}&format=${format}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-3">
        <Download aria-hidden className="size-3.5" />
        Download
      </span>
      <Button asChild size="sm" variant="secondary">
        <a href={href("json")} download>
          <FileJson aria-hidden />
          Signed JSON
        </a>
      </Button>
      <Button asChild size="sm" variant="secondary">
        <a href={href("csv")} download>
          <FileSpreadsheet aria-hidden />
          CSV
        </a>
      </Button>
      <Link href="/docs/guides/audit-export" className="text-xs text-ink-3 underline-offset-2 hover:underline">
        How to check a file
      </Link>
    </div>
  );
}
```

Check `Button asChild` with an icon inside the child (memory: `Button asChild` drops the `icon` prop, so the icon goes inside the child, as above). If `tests/ui-consistency.test.ts` rejects the raw `<a>` or the `Link` outside `ui/`, follow whatever the existing pages do for links styled as text (e.g. `MoreLink` in `src/components/vx/Treasury.tsx`) — read the test first.

- [ ] **Step 4: Wire the page.** In `src/app/o/[slug]/audit/page.tsx`:
  - import `AuditExportMenu`;
  - replace `<div className="mt-4 border-t border-line pt-4"><VerifyLedgerBadge orgSlug={slug} /></div>` with a wrapper that shows both, stacking on narrow screens:

```tsx
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
              <VerifyLedgerBadge orgSlug={slug} />
              <AuditExportMenu orgSlug={slug} />
            </div>
```

  - inside the public-key `Disclosure`, after the `<pre>` that shows the key, add:

```tsx
            <p className="mt-2">Compare this key id and the head hash with the ones a verified export prints.</p>
```

(render it only in the branch where `publicKey` is present).

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/audit-export-ui.test.tsx tests/ui-consistency.test.ts tests/audit-ledger.test.tsx tests/verify-ledger.test.tsx && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/AuditExportMenu.tsx "src/app/o/[slug]/audit/page.tsx" tests/audit-export-ui.test.tsx
git commit -m "Offer the ledger export on the Audit page"
```

---

### Task 6: The guide "Verify an audit export"

**Files:**
- Create: `content/docs/guides/audit-export.mdx`
- Modify: `src/lib/docs/content.ts` (loader entry), `src/lib/docs/nav.ts` (nav entry after "Your first payment")
- Modify: `tests/docs-guides.test.ts` (`GuideSlug` gains `"guides/audit-export"`; `QUOTED` gains its list)

**Interfaces:**
- Consumes: UI strings from Task 5 (`src/components/AuditExportMenu.tsx`: "Download", "Signed JSON", "CSV"; audit page: "Compare this key id and the head hash with the ones a verified export prints."), the verifier's messages from Task 3 (`public/tools/verify-ledger-export.mjs`: "VALID", "BROKEN", "NOT CHECKED"), and the spec's §1 facts.

- [ ] **Step 1: Write the failing test.** In `tests/docs-guides.test.ts`, add constants `const EXPORT_MENU = "src/components/AuditExportMenu.tsx";` and `const VERIFIER = "public/tools/verify-ledger-export.mjs";` (reuse `AUDIT_PAGE`, which exists), add `"guides/audit-export"` to `GuideSlug`, and add:

```ts
  "guides/audit-export": [
    ["Audit", APP_NAV],
    ["Download", EXPORT_MENU],
    ["Signed JSON", EXPORT_MENU],
    ["CSV", EXPORT_MENU],
    ["Compare this key id and the head hash with the ones a verified export prints.", AUDIT_PAGE],
    ["VALID", VERIFIER],
    ["BROKEN", VERIFIER],
    ["NOT CHECKED", VERIFIER],
    ["vestiarion-ledger-export/1", VERIFIER],
  ],
```

Check first how `QUOTED` entries are matched against the guide (exact substring) and whether other tests enumerate `GuideSlug` or the nav (docs-content, navigation, sitemap tests) — add the new slug wherever a list of guide pages is asserted.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/docs-guides.test.ts`
Expected: FAIL — the guide does not exist.

- [ ] **Step 3: Write the guide** `content/docs/guides/audit-export.mdx` (match the front matter / heading conventions of `content/docs/guides/first-payment.mdx`):

```mdx
Every decision a workspace's agent or its people make is appended to the workspace's ledger, hash-linked to the entry before it and signed with Ed25519. The Audit page checks that chain for you. An export lets someone else check it, with their own copy and without Vestiarion: an auditor, your accountant, or a counterparty.

## 1. Download the ledger

Open **Audit**. Next to the verification result, under **Download**, choose:

- **Signed JSON**: the whole chain, oldest entry first, with the public keys that vouch for it. This is the file that verifies.
- **CSV**: the same entries as a spreadsheet, one row per entry. It is for reading, not for checking: a spreadsheet may change the text it opens, and cells that would run as formulas are prefixed with `'`.

Every member of the workspace can export, viewers included. Each export is itself recorded in the ledger, as `ledger_exported`, with who exported it, the format, and how many entries it held.

## 2. What the file holds

The JSON file has the format `vestiarion-ledger-export/1`:

- `workspace`: its slug and name;
- `head`: the last entry in the file, by `seq` and `hash`;
- `keys`: every public key the workspace accepts signatures from, each with its key id;
- `verification`: what Vestiarion's own check said when the file was made;
- `entries`: every entry, exactly as stored: `seq`, `id`, `ts`, `actor`, `domain`, `action`, `summary`, `detail`, `body_hash`, `signature`, `prev_hash`, `hash` and `signing_key_id`.

An entry's `body_hash` is the SHA-256 of the canonical JSON of its `actor`, `domain`, `action`, `summary` and `detail` (keys sorted, no whitespace). Its `signature` is an Ed25519 signature over that hash. Its `hash` is the SHA-256 of `prev_hash`, `body_hash` and `signature` joined, and the first entry's `prev_hash` is 64 zeros.

## 3. Check it

Download the verifier, [verify-ledger-export.mjs](/tools/verify-ledger-export.mjs). It is one file with no dependencies beyond Node.js 20 or later. Then run:

```bash
node verify-ledger-export.mjs vestiarion-your-workspace-ledger-392.json
```

It answers with one of three results:

- **VALID** (exit code 0): every entry's content matches its hash, every signature verifies, and every link holds, from the first entry to the head. It prints the head and the key ids it trusted.
- **BROKEN** (exit code 1): it names the first entry that fails and why: its content was changed, its signature does not verify, or an entry is missing or out of order.
- **NOT CHECKED** (exit code 2): it could not check. The file is not an export, or an entry names a key the file does not hold.

## 4. Compare the key id and the head

A file can only show that it agrees with itself. Someone who rewrote the entries could re-sign them with a key of their own and put that key in the file. So, before relying on a **VALID** result, compare the key id and head hash the verifier prints with the workspace's **Audit** page. The key id is shown beside **Ledger signing public key**, and the head hash has a copy button. The page says: "Compare this key id and the head hash with the ones a verified export prints."

If you already hold the workspace's public key, pass it in, and only that key is trusted:

```bash
node verify-ledger-export.mjs vestiarion-your-workspace-ledger-392.json --public-key workspace-key.pem
```
```

Adjust the wording only where the test or the product text requires it, and keep every quoted UI string character-for-character.

- [ ] **Step 4: Register the page** in `src/lib/docs/content.ts` (`"guides/audit-export": () => import("../../../content/docs/guides/audit-export.mdx"),`) and `src/lib/docs/nav.ts` (`{ slug: "guides/audit-export", title: "Verify an audit export", description: "Download a workspace's signed ledger and check it with a standalone verifier." }` after "Your first payment").

- [ ] **Step 5: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/docs-guides.test.ts tests/docs-content.test.ts tests/docs-headings.test.ts tests/docs-markdown.test.ts tests/docs-search.test.ts`, then `npm run verify`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add content/docs/guides/audit-export.mdx src/lib/docs/content.ts src/lib/docs/nav.ts tests/docs-guides.test.ts
git commit -m "Add the guide to verifying an audit export"
```

---

## Rollout (the controller)

No migration. Push, open the PR, wait for green, merge. After the deploy, in production:
1. `GET /api/ledger/export?org=founding` signed out → 401; `/tools/verify-ledger-export.mjs` → 200.
2. The partner downloads both formats from a workspace; run the downloaded verifier on the JSON (VALID; compare the key id and head hash with the Audit page); flip one character of a `detail` in a copy (BROKEN at that seq).
3. Check `ledger_exported` on the Audit page, then record the result in spec §5 and post an arc-canteen update.
