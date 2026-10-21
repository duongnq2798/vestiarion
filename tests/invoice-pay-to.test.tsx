import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { enforceApGuardrails } from "@/lib/agent/guardrails";
import { planFollowUp } from "@/lib/agent/follow-up";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { chatDraftOf } from "@/lib/invoice-document/chat-draft";
import { documentPayToOf, documentProvenance } from "@/lib/invoice-document/provenance";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { createInvoice } from "@/lib/invoices/create";
import { readDocumentPayTo } from "@/lib/invoice-pay-to";
import { invoiceAskedFor, payToDiffers } from "@/lib/invoice-pay-to-rules";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The invoice pay-to hold (docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md IP1-IP3): the address a
 * document asked to be paid to kept with the invoice, a payment whose document asked for another held for a person,
 * decided again once the address on file is the one asked for, and shown beside the address Approve and pay sends to.
 */

vi.mock("server-only", () => ({}));

const ON_FILE = "0x1111111111111111111111111111111111111111";
const ASKED = "0x7a2dC41e9b03F6a85d1c27e4b98f0a3c61d5e10d";
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";

describe("whether the invoice asked for another address (IP2)", () => {
  it("says so only when a document named an address and it is not the one on file, case ignored", () => {
    expect(payToDiffers(ASKED, ON_FILE)).toBe(true);
    expect(payToDiffers(ASKED, null)).toBe(true);
    expect(payToDiffers(ASKED, ASKED.toLowerCase())).toBe(false);
    expect(payToDiffers(null, ON_FILE)).toBe(false);
    expect(payToDiffers(undefined, null)).toBe(false);
  });

  it("keeps only a 0x address from a reading", () => {
    expect(documentPayToOf({ payToAddress: ` ${ASKED} ` })).toBe(ASKED);
    expect(documentPayToOf({ payToAddress: "not an address" })).toBeNull();
    expect(documentPayToOf({ payToAddress: `${ASKED}0` })).toBeNull();
    expect(documentPayToOf({})).toBeNull();
    expect(documentPayToOf(null)).toBeNull();
  });
});

describe("the guardrail (IP2)", () => {
  const base = { action: "pay" as const, reasoning: "Due and matched.", amount: 50, riskLevel: "low", paymentLimit: 1000 };

  it("holds a payment whose invoice asked for another address, naming both", () => {
    const result = enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: ON_FILE });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "invoice.pay_to_differs" });
    expect(result.reasoning).toContain(`the invoice asks to be paid to ${ASKED}, not the address on file (${ON_FILE})`);
  });

  it("says so when there is no address on file at all", () => {
    const result = enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: null });
    expect(result.rule).toBe("invoice.pay_to_differs");
    expect(result.reasoning).toContain(`the invoice asks to be paid to ${ASKED}, and there is no address on file`);
  });

  it("leaves a vendor paid to a bank account to the bank payout's own rule", () => {
    expect(enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: ON_FILE, paidToBank: true }).rule).not.toBe("invoice.pay_to_differs");
  });

  it("lets it through when the document named none or the same address", () => {
    expect(enforceApGuardrails({ ...base, documentPayTo: null, addressOnFile: ON_FILE }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, documentPayTo: ASKED.toUpperCase().replace("0X", "0x"), addressOnFile: ASKED.toLowerCase() }).blocked).toBe(false);
  });

  it("comes after the address checks, which give the stronger reason, and before the three-way match", () => {
    expect(enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: ON_FILE, addressChangedAt: "2026-10-20T00:00:00Z", addressConfirmedAt: null }).rule).toBe(
      "counterparty.address_unconfirmed"
    );
    expect(enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: null, addressMissing: true }).rule).toBe("counterparty.no_address");
    expect(
      enforceApGuardrails({ ...base, documentPayTo: ASKED, addressOnFile: ON_FILE, match: { poReference: null, goodsReceived: false, purchaseOrderRequired: true } }).rule
    ).toBe("invoice.pay_to_differs");
  });
});

describe("the follow-up (IP3)", () => {
  const frozen = { id: INVOICE, status: "held", amount: 50, currency: "USDC" as const, dueDate: "2026-10-31", decidedAt: "2026-10-21T00:00:00Z", escalatedAt: null, poReference: null, goodsReceived: true, riskLevel: "low", paymentLimit: 1000 };
  const atDecision = { poReference: null, goodsReceived: true, riskLevel: "low", paymentLimit: 1000, payToHeld: true };
  const config = { reopenOnChange: true, escalateAfterDays: 3, closeAfterDays: 30 } as unknown as Parameters<typeof planFollowUp>[3];
  const MOVED = "the address on file is now the one the invoice asked to be paid to";

  it("decides it again once the address on file is the one the invoice asked for, and not before", () => {
    expect(planFollowUp({ ...frozen, payToDiffers: true }, atDecision, Date.parse("2026-10-21T01:00:00Z"), config).changes ?? []).not.toContain(MOVED);
    expect(planFollowUp({ ...frozen, payToDiffers: false }, atDecision, Date.parse("2026-10-21T01:00:00Z"), config).changes).toContain(MOVED);
    // Unread, nothing moves.
    expect(planFollowUp(frozen, atDecision, Date.parse("2026-10-21T01:00:00Z"), config).changes ?? []).not.toContain(MOVED);
  });
});

describe("what each path keeps (IP1)", () => {
  it("reads it from the invoice form's reading, beside the fields a person changed", () => {
    const form = new FormData();
    form.set("documentSha256", "a".repeat(64));
    form.set("documentKind", "pdf");
    form.set("documentReader", "deepseek");
    form.set("documentRead", JSON.stringify({ amount: "50", payToAddress: ASKED }));
    const submitted = { amount: "50", currency: "USDC", dueDate: null, poReference: null, earlyPayDiscountPct: null, discountDeadline: null, memo: null, counterpartyId: null };
    expect(documentProvenance(form, submitted)).toMatchObject({ payTo: ASKED });
    form.set("documentRead", JSON.stringify({ amount: "50" }));
    expect(documentProvenance(form, submitted)).not.toHaveProperty("payTo");
  });

  it("keeps it with a chat's or an email's stored draft", () => {
    const read = {
      draft: { vendorName: "Northwind", invoiceNumber: "7", amount: "50", currency: "USDC" as const, dueDate: "2026-10-31", poReference: null, earlyPayDiscountPct: null, discountDeadline: null, payToAddress: ASKED, memo: null, counterpartyId: COUNTERPARTY },
      counterpartyName: "Northwind",
      warnings: [],
      notFound: [],
      modelNote: null,
      reader: "deepseek" as const,
      document: { kind: "pdf" as const, sha256: "b".repeat(64), truncated: false },
    };
    expect(chatDraftOf(read).stored?.document).toEqual({ kind: "pdf", sha256: "b".repeat(64), reader: "deepseek", payTo: ASKED });
    expect(chatDraftOf({ ...read, draft: { ...read.draft, payToAddress: null } }).stored?.document).not.toHaveProperty("payTo");
  });
});

describe("adding the invoice (IP1)", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });
  const orgs = signedOrgs();
  const invoice = invoiceInputSchema.parse({ direction: "payable", counterpartyId: COUNTERPARTY, amount: "50", currency: "USDC", memo: "", poReference: "", goodsReceived: true, dueDate: "2026-10-31", earlyPayDiscountPct: "", discountDeadline: "" });
  const document = { kind: "pdf" as const, sha256: "a".repeat(64), reader: "deepseek" as const, changed: [], payTo: ASKED };

  async function add(beforeMigration: boolean) {
    let inserts = 0;
    const fake = fakeSupabase((sent: RecordedRequest) => {
      if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
      if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
      if (sent.path === "/rest/v1/counterparties") return { body: { id: COUNTERPARTY, name: "Northwind" } };
      if (sent.path === "/rest/v1/invoices" && sent.method === "POST") {
        inserts += 1;
        if (beforeMigration && "document_pay_to" in (sent.body as Record<string, unknown>)) {
          return { status: 400, body: { code: "PGRST204", details: null, hint: null, message: "Could not find the 'document_pay_to' column of 'invoices' in the schema cache" } };
        }
        return { body: { id: INVOICE } };
      }
      return { body: [] };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => createInvoice({ actorId: USER, invoice, document }), { userId: USER }));
    return { result, requests: fake.requests, inserts: () => inserts };
  }

  it("keeps the address on the invoice and in its ledger entry's document", async () => {
    const { result, requests } = await add(false);
    expect(result).toEqual({ id: INVOICE, counterpartyName: "Northwind" });
    const insert = requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ document_pay_to: ASKED });
    const entry = requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: { document: unknown } };
    expect(entry.p_detail.document).toEqual(document);
  });

  it("adds the invoice without it before migration 0136, as before", async () => {
    const { result, requests, inserts } = await add(true);
    expect(result).toEqual({ id: INVOICE, counterpartyName: "Northwind" });
    expect(inserts()).toBe(2);
    const last = requests.filter((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST").pop();
    expect(last?.body).not.toHaveProperty("document_pay_to");
  });
});

describe("reading what the documents asked for (IP2)", () => {
  function reader(answer: (sent: RecordedRequest) => { status?: number; body: unknown }) {
    const fake = fakeSupabase(answer);
    return { db: fake.client as unknown as Parameters<typeof readDocumentPayTo>[1], requests: fake.requests };
  }

  it("reads the invoices that named an address, a hundred ids at a time", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const { db, requests } = reader(() => ({ body: [{ id: ids[0], document_pay_to: ASKED }] }));
    const found = await readDocumentPayTo(ids, db);
    expect(found.get(ids[0])).toBe(ASKED);
    expect(requests.filter((sent) => sent.path === "/rest/v1/invoices")).toHaveLength(2);
    expect(requests[0].params.get("document_pay_to")).toBe("not.is.null");
  });

  it("reads none before migration 0136, and stops on any other failure", async () => {
    expect((await readDocumentPayTo(["a"], reader(() => ({ status: 400, body: { code: "42703", message: "column invoices.document_pay_to does not exist" } })).db)).size).toBe(0);
    await expect(readDocumentPayTo(["a"], reader(() => ({ status: 500, body: { code: "XX000", message: "down" } })).db)).rejects.toThrow(/could not be read/);
  });
});

describe("the approval card's words (IP3)", () => {
  it("names the address the invoice asked for and says the one on file is paid", () => {
    const words = renderToStaticMarkup(<p>{invoiceAskedFor(ASKED, ON_FILE)}</p>);
    expect(words).toContain(`The invoice asks to be paid to ${ASKED}. Approve and pay sends to the address above, the one on file.`);
  });

  it("says an address must be added first when there is none on file", () => {
    expect(invoiceAskedFor(ASKED, null)).toBe(
      `The invoice asks to be paid to ${ASKED}. There is no address on file: add one, after checking it with the vendor, before this can be paid. Check with the vendor, by a contact you had before, which address is theirs.`
    );
  });
});

describe("approving from a chat (IP3)", () => {
  const facts = { network: "arc-testnet" as const, amount: 50, currency: "USDC", chain: "ARC-TESTNET", address: ON_FILE, addressChangedAt: null, addressConfirmedAt: null };

  it("is refused while the invoice asks for another address, and sent to the console where both are shown", async () => {
    const { approveRefusal } = await import("@/lib/commands/chat-decisions");
    expect(approveRefusal({ ...facts, documentPayTo: ASKED }, 100, "Slack")).toMatchObject({
      code: "open_in_console",
      message: "Its invoice asks to be paid to a different address from the one on file.",
    });
    expect(approveRefusal({ ...facts, documentPayTo: ON_FILE.toUpperCase().replace("0X", "0x") }, 100, "Slack")).toBeNull();
    expect(approveRefusal({ ...facts, documentPayTo: null }, 100, "Telegram")).toBeNull();
  });
});
