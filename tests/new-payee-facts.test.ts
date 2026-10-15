import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { ARC_TESTNET } from "@/lib/network";
import { ID_CHUNK, loadNewPayeeFacts, newPayeeCheckFor, PAYMENT_PAGE } from "@/lib/new-payee-facts";
import { PAYEE } from "@/lib/new-payee";
import { executePayment, paymentIdempotencyKey, paymentMemo } from "@/lib/payments";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2): the addresses
 * each payee asked about has received a confirmed payment at, and each counterparty's ledger entries that set, confirmed
 * or asked for its address, newest first.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0c0";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const ORG_ROW = { id: ORG, slug: "demo", name: "Demo", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };

function fake(reply: (request: RecordedRequest) => FakeReply | undefined) {
  return fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: ORG_ROW } : (reply(request) ?? { body: [] })));
}

const load = (workspace: ReturnType<typeof fake>, ids: string[]) =>
  runWith({ config, db: workspace.client, fetch: workspace.fetch }, () => withOrg(ORG, () => loadNewPayeeFacts(db(), ids)));

const PAID = "0xAbC0000000000000000000000000000000000001";
const RELEASED = "0xDef0000000000000000000000000000000000002";

function workspace() {
  return fake((request) => {
    if (request.path === "/rest/v1/payment_intents") {
      return {
        body: [
          { source_type: "invoice", source_id: "inv-2", destination: PAID },
          { source_type: "milestone", source_id: "ms-1", destination: RELEASED },
          // A payment to some other payee, and one with no destination.
          { source_type: "invoice", source_id: "inv-elsewhere", destination: "0x9990000000000000000000000000000000000009" },
          { source_type: "invoice", source_id: "inv-1", destination: null },
        ],
      };
    }
    if (request.path === "/rest/v1/invoices") return { body: [{ id: "inv-1", counterparty_id: "cp-1" }, { id: "inv-2", counterparty_id: "cp-2" }] };
    if (request.path === "/rest/v1/milestones") return { body: [{ id: "ms-1", contractor_id: "cp-1" }] };
    if (request.path === "/rest/v1/ledger_entries") {
      return {
        body: [
          { action: "counterparty_address_confirmed", detail: { by: "bao", counterpartyId: "cp-1", address: "0x2" } },
          { action: "create_counterparty", detail: { by: "anna", counterpartyId: "cp-2", address: "0x3" } },
          { action: "counterparty_address_changed", detail: { by: "anna", counterpartyId: "cp-1", to: "0x2" } },
        ],
      };
    }
    return undefined;
  });
}

describe("loadNewPayeeFacts", () => {
  it("reads each payee's confirmed payments by address, lowercase, and each counterparty's address entries newest first", async () => {
    const workspaceFake = workspace();
    const facts = await load(workspaceFake, ["cp-1", "cp-2"]);
    expect([...(facts.paidTo.get("cp-1") ?? [])]).toEqual([RELEASED.toLowerCase()]);
    expect([...(facts.paidTo.get("cp-2") ?? [])]).toEqual([PAID.toLowerCase()]);
    expect(facts.entries.get("cp-1")?.map((entry) => entry.action)).toEqual(["counterparty_address_confirmed", "counterparty_address_changed"]);
    expect(facts.entries.get("cp-2")?.map((entry) => entry.action)).toEqual(["create_counterparty"]);

    const requests = workspaceFake.requests;
    const intents = requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(intents?.params.get("status")).toBe("eq.confirmed");
    expect(intents?.params.get("select")).toBe("source_type,source_id,destination");
    // Read a page at a time, in a stable order, so the row cap never drops a payment.
    expect(intents?.params.get("order")).toBe("id.asc");
    expect(intents?.params.get("offset")).toBe("0");
    expect(intents?.params.get("limit")).toBe(String(PAYMENT_PAGE));
    // Each paid invoice and milestone by its own id, and only for the payees asked about.
    const invoices = requests.find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("select")).toBe("id,counterparty_id");
    expect(invoices?.params.get("id")).toBe("in.(inv-2,inv-elsewhere)");
    expect(invoices?.params.get("counterparty_id")).toBe("in.(cp-1,cp-2)");
    const milestones = requests.find((request) => request.path === "/rest/v1/milestones");
    expect(milestones?.params.get("select")).toBe("id,contractor_id");
    expect(milestones?.params.get("id")).toBe("in.(ms-1)");
    expect(milestones?.params.get("contractor_id")).toBe("in.(cp-1,cp-2)");
    const ledger = requests.find((request) => request.path === "/rest/v1/ledger_entries");
    expect(ledger?.params.get("domain")).toBe("in.(compliance,contractor)");
    expect(ledger?.params.get("action")).toBe(
      "in.(create_counterparty,counterparty_address_changed,counterparty_address_confirmed,payee_link_created,github_bounty_attached)"
    );
    expect(ledger?.params.get("detail->>counterpartyId")).toBe("in.(cp-1,cp-2)");
    expect(ledger?.params.get("order")).toBe("seq.desc");
  });

  it("reads nothing when no counterparty is asked about", async () => {
    const workspaceFake = workspace();
    const facts = await load(workspaceFake, []);
    expect(facts.entries.size).toBe(0);
    expect(facts.paidTo.size).toBe(0);
    expect(workspaceFake.requests.filter((request) => request.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("reads every page of confirmed payments, and the invoices they paid in chunks, so the row cap never drops one", async () => {
    const elsewhere = Array.from({ length: PAYMENT_PAGE }, (_, index) => ({ source_type: "invoice", source_id: `inv-x${index}`, destination: "0x9990000000000000000000000000000000000009" }));
    const paged = fake((request) => {
      if (request.path === "/rest/v1/payment_intents") {
        // A full first page, then the payment that paid cp-1, alone on the second.
        return { body: request.params.get("offset") === "0" ? elsewhere : [{ source_type: "invoice", source_id: "inv-1", destination: PAID }] };
      }
      if (request.path === "/rest/v1/invoices") {
        const asked = request.params.get("id") ?? "";
        return { body: asked.includes("inv-1,") || asked.endsWith("inv-1)") ? [{ id: "inv-1", counterparty_id: "cp-1" }] : [] };
      }
      return undefined;
    });
    const facts = await load(paged, ["cp-1"]);
    expect([...(facts.paidTo.get("cp-1") ?? [])]).toEqual([PAID.toLowerCase()]);
    const pages = paged.requests.filter((request) => request.path === "/rest/v1/payment_intents").map((request) => request.params.get("offset"));
    expect(pages).toEqual(["0", String(PAYMENT_PAGE)]);
    const chunks = paged.requests.filter((request) => request.path === "/rest/v1/invoices").map((request) => (request.params.get("id") ?? "").split(",").length);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(ID_CHUNK);
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(PAYMENT_PAGE + 1);
  });

  it("reads every page of address entries, newest first, so the row cap never drops the entry that set the address", async () => {
    // A thousand confirmations of an older address, then, on the second page, the entry that set it: none is dropped.
    const confirmations = Array.from({ length: PAYMENT_PAGE }, () => ({ action: "counterparty_address_confirmed", detail: { by: "bao", counterpartyId: "cp-1", address: "0x2" } }));
    const paged = fake((request) => {
      if (request.path !== "/rest/v1/ledger_entries") return undefined;
      return { body: request.params.get("offset") === "0" ? confirmations : [{ action: "create_counterparty", detail: { by: "anna", counterpartyId: "cp-1", address: "0x2" } }] };
    });
    const facts = await load(paged, ["cp-1"]);
    expect(facts.entries.get("cp-1")).toHaveLength(PAYMENT_PAGE + 1);
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: "0x2" })).toMatchObject({ addressBy: "anna", confirmedBy: "bao", twoParties: true });
    const pages = paged.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    expect(pages.map((request) => request.params.get("offset"))).toEqual(["0", String(PAYMENT_PAGE)]);
    expect(pages.every((request) => request.params.get("order") === "seq.desc" && request.params.get("limit") === String(PAYMENT_PAGE))).toBe(true);
  });

  it("asks which payee a payment was for only when a payment was confirmed", async () => {
    const quiet = fake((request) => (request.path === "/rest/v1/payment_intents" ? { body: [] } : undefined));
    const facts = await load(quiet, ["cp-1"]);
    expect(facts.paidTo.size).toBe(0);
    expect(quiet.requests.some((request) => request.path === "/rest/v1/invoices" || request.path === "/rest/v1/milestones")).toBe(false);
  });
});

/**
 * A first payment is keyed on the payee and the address together (independent review, 2026-10-15, I4): an address the
 * workspace has paid for someone else is still a first payment for this payee. Otherwise a member whose own wallet was
 * once paid, as a contractor or a commission partner, could point any vendor at it, confirm it alone, and be paid.
 */
describe("newPayeeCheckFor and an address paid for another payee", () => {
  it("is a first payment for a payee never paid there, whatever the workspace paid that address for someone else", async () => {
    const facts = await load(workspace(), ["cp-1", "cp-2"]);
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: PAID })).toMatchObject({ firstPayment: true });
    expect(newPayeeCheckFor(facts, { id: "cp-2", address: PAID })).toMatchObject({ firstPayment: false });
    // However the address is written.
    expect(newPayeeCheckFor(facts, { id: "cp-2", address: PAID.toLowerCase() })).toMatchObject({ firstPayment: false });
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: RELEASED.toUpperCase().replace("0X", "0x") })).toMatchObject({ firstPayment: false });
  });

  it("asks nothing of a payee with no address", async () => {
    const facts = await load(workspace(), ["cp-1"]);
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: null })).toBeNull();
  });
});

/**
 * Who asked the payee for an address they sent (independent review, 2026-10-15): the signed `payee_link_created` or
 * `github_bounty_attached` entry, read with the address's own entries. A link's row is read only when its entry is
 * missing, and an address no one can be named for waits for a person.
 */
describe("loadNewPayeeFacts and an address the payee sent", () => {
  const ANNA = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
  const BAO = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
  const LINK = "7c1e2d3f-0000-4000-8000-00000000c1c1";
  const ADDRESS = "0x2222222222222222222222222222222222222222";

  function linkWorkspace(options: { signedBy?: string; rows?: Array<{ id: string; created_by: string | null }>; confirmedBy?: string }) {
    return fake((request) => {
      if (request.path === "/rest/v1/payment_intents") return { body: [] };
      if (request.path === "/rest/v1/ledger_entries") {
        return {
          body: [
            { action: "counterparty_address_confirmed", detail: { by: options.confirmedBy ?? ANNA, counterpartyId: "cp-1", address: ADDRESS, via: "confirm" } },
            { action: "counterparty_address_changed", detail: { by: null, via: "payee_link", linkId: LINK, counterpartyId: "cp-1", from: null, to: ADDRESS } },
            ...(options.signedBy ? [{ action: "payee_link_created", detail: { by: options.signedBy, counterpartyId: "cp-1", linkId: LINK, expiresAt: "2026-10-22T00:00:00Z" } }] : []),
            { action: "create_counterparty", detail: { by: ANNA, counterpartyId: "cp-1", address: null } },
          ],
        };
      }
      if (request.path === "/rest/v1/payee_links") return { body: options.rows ?? [] };
      return undefined;
    });
  }
  const check = async (workspaceFake: ReturnType<typeof fake>) => newPayeeCheckFor(await load(workspaceFake, ["cp-1"]), { id: "cp-1", address: ADDRESS });

  it("names the member who created the link from its signed entry, read with the address's own, and reads no link row", async () => {
    const workspaceFake = linkWorkspace({ signedBy: ANNA, confirmedBy: BAO });
    expect(await check(workspaceFake)).toMatchObject({ addressBy: PAYEE, linkCreatedBy: ANNA, confirmedBy: BAO, twoParties: true });
    expect(workspaceFake.requests.some((request) => request.path === "/rest/v1/payee_links")).toBe(false);
  });

  it("holds the first payment when the member who created the link is the one who confirmed the address", async () => {
    expect(await check(linkWorkspace({ signedBy: ANNA, confirmedBy: ANNA }))).toMatchObject({ linkCreatedBy: ANNA, twoParties: false });
  });

  it("still holds it once that member's account is deleted, which empties the link's row but not the signed entry", async () => {
    expect(await check(linkWorkspace({ signedBy: ANNA, confirmedBy: ANNA, rows: [{ id: LINK, created_by: null }] }))).toMatchObject({
      linkCreatedBy: ANNA,
      twoParties: false,
    });
  });

  it("reads the link's own row in this workspace only when its signed entry is missing", async () => {
    const workspaceFake = linkWorkspace({ rows: [{ id: LINK, created_by: ANNA }], confirmedBy: ANNA });
    expect(await check(workspaceFake)).toMatchObject({ linkCreatedBy: ANNA, twoParties: false });
    const read = workspaceFake.requests.find((request) => request.path === "/rest/v1/payee_links");
    expect(read?.params.get("select")).toBe("id,created_by");
    expect(read?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(read?.params.get("id")).toBe(`in.(${LINK})`);
    const entry = (await load(linkWorkspace({ rows: [{ id: LINK, created_by: ANNA }] }), ["cp-1"])).entries.get("cp-1")?.find((row) => row.detail.via === "payee_link");
    // Beside the entry, never in the ledger's own detail.
    expect(entry).toMatchObject({ linkCreatedBy: ANNA });
    expect(entry?.detail).not.toHaveProperty("linkCreatedBy");
  });

  it("holds it for a person, whoever confirmed it, when neither the entry nor the row names a creator", async () => {
    for (const rows of [[], [{ id: LINK, created_by: null }]]) {
      expect(await check(linkWorkspace({ rows, confirmedBy: BAO }))).toMatchObject({ addressBy: PAYEE, confirmedBy: BAO, twoParties: false });
    }
  });

  it("names the member a GitHub bounty acts as for an address sent with /payto on its pull request", async () => {
    const pull = "https://github.com/acme/app/pull/42";
    const workspaceFake = fake((request) => {
      if (request.path === "/rest/v1/payment_intents") return { body: [] };
      if (request.path === "/rest/v1/ledger_entries") {
        return {
          body: [
            { action: "counterparty_address_confirmed", detail: { by: ANNA, counterpartyId: "cp-1", address: ADDRESS, via: "confirm" } },
            { action: "counterparty_address_changed", detail: { by: null, via: "github", login: "octocat", commentUrl: `${pull}#issuecomment-9`, counterpartyId: "cp-1", to: ADDRESS } },
            { action: "github_bounty_attached", detail: { by: ANNA, via: "github", pullRequest: pull, counterpartyId: "cp-1", milestoneId: "ms-1" } },
          ],
        };
      }
      return undefined;
    });
    expect(await check(workspaceFake)).toMatchObject({ addressBy: PAYEE, bountyBy: ANNA, twoParties: false });
    expect(workspaceFake.requests.some((request) => request.path === "/rest/v1/payee_links")).toBe(false);
  });

  it("reads no link when no address came through one", async () => {
    const workspaceFake = workspace();
    await load(workspaceFake, ["cp-1", "cp-2"]);
    expect(workspaceFake.requests.some((request) => request.path === "/rest/v1/payee_links")).toBe(false);
  });
});

/**
 * A confirmed payment counts at the address its transfer went to (N2). A payable first sent to the payee's old address
 * and held, then paid by a person once the payee gave a new one, went to the new address: that address has been paid,
 * and the old one never was. The intent is written once per source, so the address is recorded again when it is sent.
 */
describe("loadNewPayeeFacts after a payment sent again to the payee's new address", () => {
  const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bcf01";
  const OLD = "0x1111111111111111111111111111111111111111";
  const NEW = "0x2222222222222222222222222222222222222222";

  function confirmed(providerTxId: string): TransferResult {
    return {
      providerTxId, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed", feeUsd: 0.003,
      feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  const provider = (reconciled: TransferResult | null) =>
    ({
      network: ARC_TESTNET, mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003,
      transfer: async () => confirmed("circle-tx-2"),
      reconcileTransfer: async () => reconciled as TransferResult,
      findTransferByRef: async () => null,
      getBalance: async (): Promise<BalanceSnapshot> => { throw new Error("not used"); },
      depositToEarn: async (): Promise<EarnResult> => { throw new Error("not used"); },
      withdrawFromEarn: async (): Promise<EarnResult> => { throw new Error("not used"); },
    }) as unknown as ChainProvider;

  /** The workspace's `payment_intents` (tests/support/payment-intents.ts), with the invoice's held first attempt to OLD. */
  function paidWorkspace(firstAttempt: Record<string, unknown>) {
    const intents = paymentIntentsBackend(ORG);
    const row = intents.insert({
      source_type: "invoice", source_id: INVOICE, idempotency_key: paymentIdempotencyKey("invoice", INVOICE),
      provider: "circle", provider_mode: "live", amount: 150, destination: OLD,
    });
    Object.assign(row, { attempt_count: 1, ...firstAttempt });
    return fake((request) => {
      if (request.path === "/rest/v1/payment_intents" && request.method === "GET" && request.params.get("status") === "eq.confirmed") {
        const paid = intents.rows.filter((intent) => intent.status === "confirmed");
        return { body: request.params.get("offset") === "0" ? paid.map(({ source_type, source_id, destination }) => ({ source_type, source_id, destination })) : [] };
      }
      if (request.path === "/rest/v1/payment_intents" || request.path.startsWith("/rest/v1/rpc/")) return intents.respond(request);
      if (request.path === "/rest/v1/invoices") return { body: [{ id: INVOICE, counterparty_id: "cp-1" }] };
      return undefined;
    });
  }

  it.each([
    ["a send Circle refused", { status: "failed", last_error: "insufficient funds" }, null],
    [
      "a transfer Circle ended in a terminal failure",
      { status: "failed", provider_tx_id: "circle-tx-1", provider_state: "FAILED" },
      { ...confirmed("circle-tx-1"), status: "failed", txHash: null, providerState: "FAILED", failureReason: "INSUFFICIENT_FUNDS" },
    ],
  ] as const)("counts the new address as paid and the old one as never paid, after %s", async (_, firstAttempt, reconciled) => {
    const workspaceFake = paidWorkspace(firstAttempt);
    await runWith({ config, db: workspaceFake.client, fetch: workspaceFake.fetch }, () =>
      withOrg(ORG, () =>
        executePayment(
          { sourceType: "invoice", sourceId: INVOICE, fromAccountId: "account-1", destination: NEW, amount: 150, memo: paymentMemo("invoice", INVOICE) },
          { provider: provider(reconciled as TransferResult | null), retryTerminalFailure: true }
        )
      )
    );

    const facts = await load(workspaceFake, ["cp-1"]);

    expect([...(facts.paidTo.get("cp-1") ?? [])]).toEqual([NEW]);
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: NEW })).toMatchObject({ firstPayment: false });
    expect(newPayeeCheckFor(facts, { id: "cp-1", address: OLD })).toMatchObject({ firstPayment: true });
  });
});
