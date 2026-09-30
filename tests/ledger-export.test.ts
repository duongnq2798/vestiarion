import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { canonicalJson, verifyChain, type LedgerEntryInput } from "@/lib/ledger";
import {
  csvCell,
  EXPORT_LIMIT,
  exportFileName,
  exportFromRows,
  exportKeys,
  LEDGER_EXPORT_FIELDS,
  LEDGER_EXPORT_FORMAT,
  ledgerExportCsvChunks,
  ledgerExportJsonChunks,
  recentExportsBy,
} from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

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
      for (const field of LEDGER_EXPORT_FIELDS) expect(entry[field]).toEqual((rows[i] as unknown as Record<string, unknown>)[field]);
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
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", " =1+1", "  +1", "﻿=1+1", " \t@SUM(A1)"])(
    "neutralises a formula start: %j",
    (value) => {
      expect(csvCell(value).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    }
  );

  it.each(["a=b", "total -5"])("does not neutralise a formula character that isn't at the start: %j", (value) => {
    expect(csvCell(value).startsWith("'")).toBe(false);
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

  it("starts with a BOM, so Excel on Windows reads it as UTF-8", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("has the chain fields as its header and one row per entry, oldest first", () => {
    const [header] = csv.split("\r\n");
    expect(header).toBe(`﻿${LEDGER_EXPORT_FIELDS.join(",")}`);
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

describe("recentExportsBy", () => {
  const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e0e2";
  const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  function scoped(respondEntries: (request: RecordedRequest) => { body: unknown }) {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") {
        return {
          body: {
            id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", wallet_host: null,
            ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null,
          },
        };
      }
      if (request.path === "/rest/v1/ledger_entries") return respondEntries(request);
      return { body: [] };
    });
    return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
  }

  it("counts ledger_exported entries by this user in the window, with the query's own filters", async () => {
    const { fake, run } = scoped(() => ({ body: [{ id: "e1" }, { id: "e2" }] }));
    const count = await run(() => recentExportsBy(USER, NOW));
    expect(count).toBe(2);

    const request = fake.requests.find((r) => r.path === "/rest/v1/ledger_entries");
    expect(request?.params.get("action")).toBe("eq.ledger_exported");
    expect(request?.params.get("ts")).toBe(`gt.${new Date(NOW.getTime() - EXPORT_LIMIT.windowMs).toISOString()}`);
    expect(request?.params.get("detail->>by")).toBe(`eq.${USER}`);
    expect(request?.params.get("limit")).toBe(String(EXPORT_LIMIT.count));
    expect(request?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("reports at most the limit, even if more rows exist", async () => {
    const { run } = scoped(() => ({
      body: Array.from({ length: EXPORT_LIMIT.count }, (_, i) => ({ id: `e${i}` })),
    }));
    expect(await run(() => recentExportsBy(USER, NOW))).toBe(EXPORT_LIMIT.count);
  });

  it("is zero when nothing was exported recently", async () => {
    const { run } = scoped(() => ({ body: [] }));
    expect(await run(() => recentExportsBy(USER, NOW))).toBe(0);
  });
});
