import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { changeInboxAddress, inboxFor, inboxOfCode, turnInboxOff, turnInboxOn } from "@/lib/email-inbox/inboxes";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A workspace's address for invoices by email (email invoices design E2): turned on once with a random 12-character
 * base32 code, changed for a new one, or turned off, each recorded in the workspace's own ledger without the address;
 * and found again by the code an address carries.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e12";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const ROW = { id: "inbox-1", org_id: ORG, code: "abcdefghij23", created_at: "2026-10-03T16:00:00Z" };

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run };
}

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });
const writes = (requests: RecordedRequest[], method: string) => requests.filter((sent) => sent.path === "/rest/v1/invoice_inboxes" && sent.method === method);

describe("turnInboxOn", () => {
  it("gives the workspace a random 12-character code, and records it without the address", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/invoice_inboxes" && sent.method === "POST" ? { body: [{ ...ROW, ...(sent.body as object) }] } : undefined));
    const inbox = await run(() => turnInboxOn(ORG, USER));

    const [insert] = writes(fake.requests, "POST");
    const code = (insert.body as { code: string }).code;
    expect(code).toMatch(/^[a-z2-7]{12}$/);
    expect(insert.body).toEqual({ org_id: ORG, code, created_by: USER });
    expect(inbox.code).toBe(code);
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("invoice_inbox_on");
    expect(entry.p_detail).toEqual({ by: USER });
    expect(JSON.stringify(entry)).not.toContain(code);
  });

  it("keeps the address a workspace already has", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/invoice_inboxes" && sent.method === "GET" ? { body: [ROW] } : undefined));
    expect((await run(() => turnInboxOn(ORG, USER))).code).toBe("abcdefghij23");
    expect(writes(fake.requests, "POST")).toEqual([]);
    expect(ledger(fake.requests)).toEqual([]);
  });

  it("never gives two workspaces the same code", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { fake, run } = world((sent) => (sent.path === "/rest/v1/invoice_inboxes" && sent.method === "POST" ? { body: [{ ...ROW, ...(sent.body as object) }] } : undefined));
      await run(() => turnInboxOn(ORG, USER));
      codes.add((writes(fake.requests, "POST")[0].body as { code: string }).code);
    }
    expect(codes.size).toBe(50);
  });
});

describe("changeInboxAddress", () => {
  it("replaces the code, so the old address stops at once, and records the change", async () => {
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/invoice_inboxes" && sent.method === "PATCH" ? { body: [{ ...ROW, ...(sent.body as object) }] } : undefined
    );
    const inbox = await run(() => changeInboxAddress(ORG, USER));

    const [update] = writes(fake.requests, "PATCH");
    expect(update.params.get("org_id")).toBe(`eq.${ORG}`);
    expect((update.body as { code: string }).code).toMatch(/^[a-z2-7]{12}$/);
    expect(inbox?.code).not.toBe("abcdefghij23");
    expect(ledger(fake.requests).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["invoice_inbox_changed", { by: USER }]]);
  });

  it("changes nothing for a workspace without an address", async () => {
    const { fake, run } = world();
    expect(await run(() => changeInboxAddress(ORG, USER))).toBeNull();
    expect(ledger(fake.requests)).toEqual([]);
  });
});

describe("turnInboxOff", () => {
  it("removes the address and records it; the emails already in stay", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/invoice_inboxes" && sent.method === "DELETE" ? { body: [{ id: "inbox-1" }] } : undefined));
    expect(await run(() => turnInboxOff(ORG, USER))).toBe(true);
    expect(writes(fake.requests, "DELETE")[0].params.get("org_id")).toBe(`eq.${ORG}`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/inbox_emails")).toBe(false);
    expect(ledger(fake.requests).map((entry) => entry.p_action)).toEqual(["invoice_inbox_off"]);
  });
});

describe("lookups", () => {
  it("finds a workspace's address, and the workspace an address's code names", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/invoice_inboxes" ? { body: [ROW] } : undefined));
    expect(await run(() => inboxFor(ORG))).toEqual({ id: "inbox-1", orgId: ORG, code: "abcdefghij23", createdAt: "2026-10-03T16:00:00Z" });
    expect(await run(() => inboxOfCode("abcdefghij23"))).toMatchObject({ orgId: ORG });
    const byCode = fake.requests.filter((sent) => sent.path === "/rest/v1/invoice_inboxes")[1];
    expect(byCode.params.get("code")).toBe("eq.abcdefghij23");
  });

  it("asks nothing for a code that is not one", async () => {
    const { fake, run } = world();
    expect(await run(() => inboxOfCode("../../etc"))).toBeNull();
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoice_inboxes")).toBe(false);
  });
});
