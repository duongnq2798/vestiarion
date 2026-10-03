import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCounterparty } from "@/lib/counterparties/create";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { counterpartyInputSchema } from "@/lib/intake-validation";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `createCounterparty`, the one way a counterparty is added, from the console form or the write API (write API R2–R4):
 * the row, its `create_counterparty` entry, and its first screening. An address that arrives through the API is stored
 * as an unconfirmed change, so the agent pays it only once a person confirms it.
 */

const { screenMock } = vi.hoisted(() => ({ screenMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/compliance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/compliance")>()), screenCounterparty: screenMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const KEY_ID = "1a1a1a1a-0000-4000-8000-00000000001a";
const CREATED = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const ADDRESS = `0x${"ab".repeat(20)}`;
const NOW = "2026-10-03T10:00:00.000Z";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

beforeEach(() => {
  screenMock.mockReset();
  screenMock.mockResolvedValue({ riskLevel: "clear" });
});

function workspace() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/counterparties" && sent.method === "POST") return { body: { id: CREATED, name: "Quill Studio" } };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER })) };
}

const input = (overrides: Record<string, string> = {}) =>
  counterpartyInputSchema.parse({ name: "Quill Studio", role: "vendor", address: ADDRESS, chain: "ARC-TESTNET", jurisdiction: "VN", paymentLimit: "25", ...overrides });

const insertOf = (requests: RecordedRequest[]) => requests.find((sent) => sent.path === "/rest/v1/counterparties" && sent.method === "POST")?.body as Record<string, unknown>;
const ledgerOf = (requests: RecordedRequest[]) =>
  requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_action: string; p_actor: string; p_detail: Record<string, unknown> };

describe("createCounterparty", () => {
  it("adds the counterparty in the workspace, records it as the person's, and screens it", async () => {
    const { fake, run } = workspace();
    const result = await run(() => createCounterparty({ actorId: USER, counterparty: input(), now: () => NOW }));

    expect(result).toEqual({ id: CREATED, name: "Quill Studio", screening: { riskLevel: "clear" } });
    expect(insertOf(fake.requests)).toMatchObject({
      org_id: ORG, name: "Quill Studio", role: "vendor", address: ADDRESS, chain: "ARC-TESTNET", jurisdiction: "VN", baseline_payment_limit: "25", payment_limit: null,
    });
    // An address a person typed into the console is theirs: it is not a change waiting for confirmation.
    expect(insertOf(fake.requests)).not.toHaveProperty("address_changed_at");
    expect(ledgerOf(fake.requests)).toMatchObject({ p_action: "create_counterparty", p_actor: "human", p_detail: { by: USER, counterpartyId: CREATED, role: "vendor" } });
    expect(ledgerOf(fake.requests).p_detail).not.toHaveProperty("via");
    expect(screenMock).toHaveBeenCalledWith(CREATED);
  });

  it("stores an address that came through the API as a change waiting for a person (write API R3)", async () => {
    const { fake, run } = workspace();
    await run(() => createCounterparty({ actorId: USER, counterparty: input(), via: "api", apiKeyId: KEY_ID, now: () => NOW }));

    expect(insertOf(fake.requests)).toMatchObject({ address: ADDRESS, address_changed_at: NOW });
    expect(insertOf(fake.requests)).not.toHaveProperty("address_confirmed_at");
    expect(ledgerOf(fake.requests).p_detail).toMatchObject({ via: "api", apiKeyId: KEY_ID, addressNeedsConfirmation: true });
  });

  it("marks nothing to confirm when the API gives no address", async () => {
    const { fake, run } = workspace();
    await run(() => createCounterparty({ actorId: USER, counterparty: input({ address: "" }), via: "api", apiKeyId: KEY_ID, now: () => NOW }));

    expect(insertOf(fake.requests)).not.toHaveProperty("address_changed_at");
    expect(ledgerOf(fake.requests).p_detail).toMatchObject({ addressNeedsConfirmation: false });
  });

  it("still adds the counterparty when screening fails, and says so", async () => {
    screenMock.mockRejectedValue(new Error("OpenSanctions unavailable"));
    const { run } = workspace();
    const result = await run(() => createCounterparty({ actorId: USER, counterparty: input(), now: () => NOW }));
    expect(result).toEqual({ id: CREATED, name: "Quill Studio", screening: { error: "OpenSanctions unavailable" } });
  });

  it("records an issuer whose account is gone as no one", async () => {
    const { fake, run } = workspace();
    await run(() => createCounterparty({ actorId: null, counterparty: input(), via: "api", apiKeyId: KEY_ID, now: () => NOW }));
    expect(ledgerOf(fake.requests).p_detail).toMatchObject({ by: null });
  });
});
