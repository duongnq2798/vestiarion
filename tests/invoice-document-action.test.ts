import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { readInvoiceDocumentAction } from "@/app/actions/invoice-document";
import { takeDocumentReadToken } from "@/lib/rate-limit";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Reading an invoice document into a draft (invoice from a document D1–D9).
 * Authorization and the organization scope are stand-ins; the reading, the
 * rule-based reader (no model is configured here), the checks and the match
 * are the real ones, against a recorded supabase-js client.
 */

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor", address: null },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0df", name: "Harbor Office Supply", role: "vendor", address: null },
];

let fake: ReturnType<typeof fakeSupabase>;
let orgId = "";

vi.mock("@/lib/dal/scope", () => ({
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fake.client, orgId }), fn),
}));

let orgCounter = 0;
beforeEach(() => {
  // A workspace of its own per test: the read limit is kept per workspace, in memory.
  orgCounter += 1;
  orgId = `0b6c1c9e-4a4f-4a7e-9b1e-${String(orgCounter).padStart(12, "0")}`;
  authorizeMock.mockReset();
  authorizeMock.mockResolvedValue({
    ok: true,
    user: { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1", email: null },
    membership: { orgId, slug: "northstar", name: "Northstar", mode: "sandbox", role: "owner" },
  });
  fake = fakeSupabase((sent: RecordedRequest) => (sent.path === "/rest/v1/counterparties" ? { body: COUNTERPARTIES } : { body: [] }));
});

const fixture = (name: string) => new File([readFileSync(path.join(__dirname, "fixtures", "invoice-document", name))], name, { type: "application/pdf" });

function form(fields: { file?: File; text?: string }): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  if (fields.file) data.set("file", fields.file);
  data.set("text", fields.text ?? "");
  return data;
}

const read = (fields: { file?: File; text?: string }) => readInvoiceDocumentAction({ ok: false, message: "" }, form(fields));

describe("reading an invoice document", () => {
  it("reads a PDF into a draft matched to its counterparty, naming the reader", async () => {
    const result = await read({ file: fixture("northwind-inv-2207.pdf") });
    expect(result).toMatchObject({ ok: true, reader: "heuristic", document: { kind: "pdf", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), truncated: false } });
    expect(result.draft).toMatchObject({
      counterpartyId: COUNTERPARTIES[0].id,
      amount: "200.00",
      currency: "USDC",
      dueDate: "2026-10-31",
      poReference: "PO-1042",
      earlyPayDiscountPct: "2",
      discountDeadline: "2026-10-11",
    });
    expect(result.message).toBe("Read the invoice from Northwind Hosting. Check every field before adding it.");
    const lookup = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties");
    expect(lookup?.params.get("org_id")).toBe(`eq.${orgId}`);
  });

  it("reads pasted text", async () => {
    const result = await read({ text: "Harbor Office Supply\nInvoice number: H-77\nDue date: 2026-10-20\nTotal due 75.00 USDC" });
    expect(result).toMatchObject({ ok: true, document: { kind: "text" }, draft: { counterpartyId: COUNTERPARTIES[1].id, amount: "75.00" } });
  });

  it("says when a PDF is a scan", async () => {
    expect(await read({ file: fixture("scan.pdf") })).toEqual({ ok: false, message: "This PDF has no text to read; it may be a scan. Paste the invoice's text instead." });
  });

  it("refuses a file over the size limit before reading it", async () => {
    const big = new File([new Uint8Array(4_000_001)], "big.pdf", { type: "application/pdf" });
    expect(await read({ file: big })).toEqual({ ok: false, message: "Choose a file of at most 4 MB." });
  });

  it("asks for a file or text when given neither", async () => {
    expect(await read({})).toEqual({ ok: false, message: "There is no text to read. Choose a file or paste the invoice's text." });
  });

  it("refuses someone who may not add invoices, before reading anything", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "You do not have permission to do that." });
    expect(await read({ text: "Total due 75.00" })).toEqual({ ok: false, message: "You do not have permission to do that." });
    expect(fake.requests).toHaveLength(0);
  });

  it("allows five reads a minute per workspace", async () => {
    for (let count = 0; count < 5; count += 1) expect((await read({ text: "Harbor Office Supply\nTotal due 75.00" })).ok).toBe(true);
    expect(await read({ text: "Harbor Office Supply\nTotal due 75.00" })).toEqual({ ok: false, message: "That is five invoices read this minute. Try again in a few seconds." });
  });
});

describe("the read limit", () => {
  it("refills one read every 12 seconds", () => {
    const now = 1_000_000;
    for (let count = 0; count < 5; count += 1) expect(takeDocumentReadToken("org-limit", now)).toBe(true);
    expect(takeDocumentReadToken("org-limit", now)).toBe(false);
    expect(takeDocumentReadToken("org-limit", now + 12_000)).toBe(true);
    expect(takeDocumentReadToken("org-limit", now + 12_000)).toBe(false);
  });
});

describe("the size of a request to a Server Action", () => {
  it("leaves room for a 4 MB document and the form's own bytes", async () => {
    const { default: nextConfig } = await import("../next.config");
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("5mb");
  });
});
