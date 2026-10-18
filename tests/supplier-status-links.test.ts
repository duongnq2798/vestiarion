import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { createSupplierLink, listSupplierLinks, stopSupplierLink, SupplierLinkError } from "@/lib/supplier-status/links";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A supplier's payment status link, in the workspace in scope (docs/superpowers/specs/2026-10-18-supplier-status-design.md
 * V1, V6): only the link's hash is stored, with its expiry; a new link stops the supplier's old one first; a link whose
 * entry cannot be written is stopped at once; stopping revokes first and records it after; a client is refused; before
 * migration 0131 runs, it says so.
 */

const { appendLedgerEntry, appendBestEffort, canSign } = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn(),
  appendBestEffort: vi.fn(async () => undefined),
  canSign: vi.fn(),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry, assertLedgerCanSign: canSign }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const SUPPLIER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000ec";
const OLD_LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.supplier_status_links' in the schema cache" } };
const NOW = Date.parse("2026-10-18T09:00:00Z");

type Row = Record<string, unknown>;

function workspace(start: { role?: string; insert?: FakeReply; missing?: boolean; patch?: FakeReply } = {}) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (start.missing) return MISSING;
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: SUPPLIER, name: "Cobalt Cloud", role: start.role ?? "vendor" }] };
    if (request.path === "/rest/v1/supplier_status_links") {
      if (request.method === "PATCH") return start.patch ?? { body: [{ id: OLD_LINK }] };
      if (request.method === "POST") return start.insert ?? { status: 201, body: { id: "new-link" } };
      return { body: [{ id: OLD_LINK, counterparty_id: SUPPLIER, revoked_at: null, created_by: USER, created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-10T00:00:00Z" }] };
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

const writes = (requests: RecordedRequest[], method: string, path: string) => requests.filter((request) => request.method === method && request.path === path);

beforeEach(() => {
  appendLedgerEntry.mockReset().mockResolvedValue({ seq: 9 });
  appendBestEffort.mockClear();
  canSign.mockReset();
});

describe("createSupplierLink", () => {
  it("stops the supplier's old link, stores only the new link's hash and expiry, and signs it", async () => {
    const { fake, run } = workspace();
    const made = await run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 30, now: NOW }));
    expect(made).toMatchObject({ linkId: "new-link", supplierName: "Cobalt Cloud", replaced: 1, expiresAt: "2026-11-17T09:00:00.000Z" });
    expect(made.token).toMatch(/^vxv_[A-Za-z0-9_-]{43}$/);

    const [stop] = writes(fake.requests, "PATCH", "/rest/v1/supplier_status_links");
    expect(stop.params.get("counterparty_id")).toBe(`eq.${SUPPLIER}`);
    expect(stop.params.get("revoked_at")).toBe("is.null");
    expect(stop.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(stop.body).toEqual({ revoked_at: new Date(NOW).toISOString(), revoked_by: USER });

    const [insert] = writes(fake.requests, "POST", "/rest/v1/supplier_status_links");
    const stored = insert.body as Row;
    expect(stored).toMatchObject({ org_id: ORG, counterparty_id: SUPPLIER, created_by: USER, expires_at: "2026-11-17T09:00:00.000Z" });
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(made.token.slice(4));

    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "supplier_status_shared",
        domain: "ap",
        detail: expect.objectContaining({ by: USER, linkId: "new-link", counterpartyId: SUPPLIER, days: 30, replaced: [OLD_LINK] }),
      })
    );
  });

  it("makes one for a contractor too", async () => {
    const { run } = workspace({ role: "contractor" });
    await expect(run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 7 }))).resolves.toMatchObject({ linkId: "new-link" });
  });

  it("refuses a client and a length it does not offer, before writing anything", async () => {
    const client = workspace({ role: "client" });
    await expect(client.run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 30 }))).rejects.toMatchObject({ code: "not_supplier" });
    expect(writes(client.fake.requests, "POST", "/rest/v1/supplier_status_links")).toEqual([]);
    const { run } = workspace();
    await expect(run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 365 }))).rejects.toBeInstanceOf(SupplierLinkError);
  });

  it("refuses before writing when the ledger cannot sign", async () => {
    canSign.mockImplementationOnce(() => {
      throw new Error("no key");
    });
    const { fake, run } = workspace();
    await expect(run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 7 }))).rejects.toThrow("no key");
    expect(fake.requests).toEqual([]);
  });

  it("stops a link whose entry could not be written, and asks to try again", async () => {
    appendLedgerEntry.mockRejectedValueOnce(new Error("ledger down"));
    const { fake, run } = workspace();
    await expect(run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 7 }))).rejects.toMatchObject({ code: "not_recorded" });
    const stops = writes(fake.requests, "PATCH", "/rest/v1/supplier_status_links");
    expect(stops.at(-1)?.params.get("id")).toBe("eq.new-link");
  });

  it("says another person made one a moment ago when the one-live index refuses", async () => {
    const { run } = workspace({ insert: { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "supplier_status_links_one_live"' } } });
    await expect(run(() => createSupplierLink({ actorId: USER, counterpartyId: SUPPLIER, days: 7 }))).rejects.toMatchObject({ code: "busy" });
  });

  it("says it is not set up before migration 0131 runs", async () => {
    const { run } = workspace({ missing: true });
    expect(await run(() => listSupplierLinks(db()))).toEqual({ available: false });
  });
});

describe("listSupplierLinks and stopSupplierLink", () => {
  it("lists links not stopped, marking an expired one", async () => {
    const { run } = workspace();
    const listed = await run(() => listSupplierLinks(db(), NOW));
    expect(listed).toEqual({
      available: true,
      links: [{ id: OLD_LINK, counterpartyId: SUPPLIER, createdBy: USER, createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-10T00:00:00Z", expired: true }],
    });
  });

  it("stops first, then records it best effort", async () => {
    const { fake, run } = workspace();
    await run(() => stopSupplierLink({ actorId: USER, linkId: OLD_LINK }));
    const [stop] = writes(fake.requests, "PATCH", "/rest/v1/supplier_status_links");
    expect(stop.params.get("id")).toBe(`eq.${OLD_LINK}`);
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "supplier_status_unshared", domain: "ap", detail: { by: USER, linkId: OLD_LINK, counterpartyId: SUPPLIER } }));
  });

  it("says a link stopped by someone else a moment ago was stopped already", async () => {
    const { run } = workspace({ patch: { body: [] } });
    await expect(run(() => stopSupplierLink({ actorId: USER, linkId: OLD_LINK }))).rejects.toMatchObject({ code: "already_stopped" });
  });
});
