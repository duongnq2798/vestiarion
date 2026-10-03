import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { readInvoiceDraft } from "@/lib/invoice-document/draft";
import { DocumentReadError } from "@/lib/invoice-document/read";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * `readInvoiceDraft`, the one reading of an invoice document, shared by **From a document** and the Telegram bot
 * (Telegram bot design R10): the file read, the rule-based reader (no model is configured here), the checks, and the
 * match against the workspace's counterparties, read in its scope.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor", address: null },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0df", name: "Harbor Office Supply", role: "vendor", address: null },
];

function inWorkspace<T>(fn: () => Promise<T>) {
  const fake = fakeSupabase((sent: RecordedRequest) => (sent.path === "/rest/v1/counterparties" ? { body: COUNTERPARTIES } : { body: [] }));
  return { fake, run: () => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
}

const pdf = readFileSync(path.join(__dirname, "fixtures", "invoice-document", "northwind-inv-2207.pdf"));

describe("readInvoiceDraft", () => {
  it("reads a PDF into a draft matched to the workspace's counterparty, naming it", async () => {
    const { fake, run } = inWorkspace(() =>
      readInvoiceDraft({ bytes: new Uint8Array(pdf), name: "northwind-inv-2207.pdf", type: "application/pdf" }, "2026-10-03")
    );
    const read = await run();

    expect(read.draft).toMatchObject({
      counterpartyId: COUNTERPARTIES[0].id,
      amount: "200.00",
      currency: "USDC",
      dueDate: "2026-10-31",
      poReference: "PO-1042",
    });
    expect(read.counterpartyName).toBe("Northwind Hosting");
    expect(read.reader).toBe("heuristic");
    expect(read.document).toEqual({ kind: "pdf", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), truncated: false });
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/counterparties")?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("leaves the counterparty unmatched, and unnamed, when the workspace holds no such counterparty", async () => {
    const text = "INVOICE INV-88 from Quillfeather Studio. Amount due: 75.00 USDC. Due date: 2026-11-01.";
    const read = await inWorkspace(() => readInvoiceDraft({ text }, "2026-10-03")).run();

    expect(read.draft.counterpartyId).toBeNull();
    expect(read.counterpartyName).toBeNull();
    expect(read.document.kind).toBe("text");
  });

  it("throws the reader's own error for a document it cannot read", async () => {
    await expect(inWorkspace(() => readInvoiceDraft({ text: "   " }, "2026-10-03")).run()).rejects.toBeInstanceOf(DocumentReadError);
  });
});
