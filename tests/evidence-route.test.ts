import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { buildEvidenceChain, EVIDENCE_MEANINGS, type EvidenceInput } from "@/lib/evidence-chain";
import { EVIDENCE_FORMAT, evidenceDocument, evidenceFileName } from "@/lib/evidence-export";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * Downloading one payment's evidence (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E7): the audit
 * export's gate (a session, membership with a 404 otherwise, no cross-site request) and a JSON file every entry of
 * which can be checked alone.
 */

const { ORG, USER, INVOICE } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e1e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
  INVOICE: "5f1e2d3c-0000-4000-8000-000000000001",
}));
const { publicKey } = crypto.generateKeyPairSync("ed25519");

const { sessionMock, membershipMock, readMock } = vi.hoisted(() => ({ sessionMock: vi.fn(), membershipMock: vi.fn(), readMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/evidence-read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidence-read")>()), readEvidence: readMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: publicKey, retired: [] }),
}));

import { GET } from "@/app/api/evidence/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MEMBERSHIP = { orgId: ORG, slug: "northstar", name: "Northstar Studio", mode: "live" as const, role: "viewer" as const };

const ENTRY = {
  seq: 20,
  id: "e20",
  ts: "2026-10-05T09:30:00Z",
  actor: "human",
  domain: "ap",
  action: "create_invoice",
  summary: "Added a bill",
  detail: { by: USER, invoiceId: INVOICE, counterpartyId: "cp", amount: 12.5, currency: "USDC", poReference: "PO-1", goodsReceived: true },
  body_hash: "b".repeat(64),
  signature: "5".repeat(128),
  prev_hash: "0".repeat(64),
  hash: "a".repeat(64),
  signing_key_id: "k1",
};
const INPUT: EvidenceInput = {
  network: "arc-testnet",
  subject: {
    kind: "invoice",
    invoice: { id: INVOICE, direction: "payable", counterparty_id: "cp", amount: 12.5, currency: "USDC", memo: "Retainer", po_reference: "PO-1", goods_received: true, due_date: "2026-10-15", status: "pending", tx_ref: null },
  },
  counterparty: { id: "cp", name: "Northstar Studio", address: null, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false },
  entries: [ENTRY],
  screening: null,
  payment: null,
  receipt: null,
  people: new Map([[USER, "alice@northstar.test"]]),
  checks: { entries: new Map([[20, { ok: true }]]), onChain: null },
};
const CHAIN = buildEvidenceChain(INPUT);

function call(query: string, headers?: Record<string, string>) {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => GET(new Request(`https://www.vestiarion.xyz/api/evidence${query}`, headers ? { headers } : undefined)));
}

const QUERY = `?org=northstar&kind=invoice&id=${INVOICE}`;

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: USER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  readMock.mockResolvedValue({ chain: CHAIN, publicKeys: {}, receipt: { state: "none" } });
});

describe("GET /api/evidence", () => {
  it("refuses a cross-site request before reading anything", async () => {
    const response = await call(QUERY, { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(sessionMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const response = await call(QUERY);
    expect(response.status).toBe(401);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("refuses a kind or an id that is not one, without looking up the workspace", async () => {
    for (const query of ["?org=northstar&kind=receivable&id=" + INVOICE, "?org=northstar&kind=invoice&id=nope", "?org=northstar"]) {
      expect((await call(query)).status).toBe(400);
    }
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it("answers a non-member 404, as for a workspace that does not exist", async () => {
    membershipMock.mockResolvedValueOnce(null);
    const response = await call(QUERY);
    expect(response.status).toBe(404);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a record the workspace does not hold, or a receivable", async () => {
    readMock.mockResolvedValueOnce(null);
    expect((await call(QUERY)).status).toBe(404);
  });

  it("gives a viewer the evidence as a JSON file, read in the workspace's scope", async () => {
    const response = await call(QUERY);
    expect(response.status).toBe(200);
    expect(readMock).toHaveBeenCalledWith("invoice", INVOICE);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-evidence-northstar-invoice-5f1e2d3c.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const doc = await response.json();
    expect(doc.format).toBe(EVIDENCE_FORMAT);
    expect(doc.workspace).toEqual({ slug: "northstar", name: "Northstar Studio" });
    expect(doc.keys).toEqual([{ id: ledgerKeyId(publicKey), status: "active", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }]);
  });

  it("says when the evidence could not be read, and nothing of why", async () => {
    readMock.mockRejectedValueOnce(new Error("relation ledger_entries: secret detail"));
    const response = await call(QUERY);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
  });
});

describe("the evidence file", () => {
  const doc = evidenceDocument({ chain: CHAIN, workspace: { slug: "northstar", name: "Northstar Studio" }, keys: [], now: new Date("2026-10-11T00:00:00Z") });

  it("carries every step with its facts, each labelled in words, and who stated each by email", () => {
    expect(doc.steps.map((step) => step.id)).toEqual(["agreed", "delivered", "bill", "payee", "decision", "people", "payment", "receipt", "signatures"]);
    const agreed = doc.steps[0];
    expect(agreed).toMatchObject({ title: "What was agreed", label: "Stated by a person", kind: "stated" });
    expect(agreed.facts[0]).toMatchObject({ label: "Stated by a person", who: "alice@northstar.test", at: "2026-10-05T09:30:00Z", entries: [20] });
    expect(doc.labels.missing).toEqual({ words: "Missing", meaning: EVIDENCE_MEANINGS.missing, facts: CHAIN.tally.missing });
    expect(doc.network).toEqual({ id: "arc-testnet", label: "Arc testnet" });
  });

  it("says in its subject whether the payment was simulated, and what a bill paid early carried", () => {
    expect(doc.subject).toMatchObject({ paid: false, simulated: false, paidAmount: null });
    const invoice = (INPUT.subject as { invoice: object }).invoice;
    const simulated = buildEvidenceChain({ ...INPUT, subject: { kind: "invoice", invoice: { ...invoice, status: "paid", tx_ref: "sim_1", paid_amount: 12.25 } as never } });
    const file = evidenceDocument({ chain: simulated, workspace: { slug: "northstar", name: "Northstar Studio" }, keys: [], now: new Date("2026-10-11T00:00:00Z") });
    expect(file.subject).toMatchObject({ status: "paid", paid: true, simulated: true, amount: 12.5, paidAmount: 12.25 });
  });

  it("carries each entry in full, with the fields the audit export carries and the server's check", () => {
    expect(doc.entries).toEqual([{ ...ENTRY, check: { ok: true } }]);
    expect(doc.checkAnEntry).toHaveLength(3);
    expect(doc.signedEntryProves).toBe("A signed entry proves who recorded what, and when. It does not prove the goods were good or the work was done.");
  });

  it("is named for the workspace, the kind and the record, and nothing a slug could smuggle", () => {
    expect(evidenceFileName("north-star", "milestone", "5f1e2d3c-0000")).toBe("vestiarion-evidence-north-star-milestone-5f1e2d3c.json");
    expect(evidenceFileName('a"b\r\nc', "invoice", "x")).toBe("vestiarion-evidence-abc-invoice-x.json");
  });
});
