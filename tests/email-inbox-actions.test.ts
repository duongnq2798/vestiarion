import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addInboxEmailAction, changeInboxAddressAction, dismissInboxEmailAction, turnOffInboxAction, turnOnInboxAction, type InboxActionResult,
} from "@/app/actions/email-inbox";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The invoices-by-email server actions (email invoices design E2, E7): adding or dismissing an emailed invoice is a
 * records write; turning the address on, changing it or turning it off is integrations.manage, as connecting Slack is.
 * Each authorizes the session first and runs as the session's member; a row id that is not one asks nothing further.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e51",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e52",
  mocks: { authorize: vi.fn(), revalidate: vi.fn(), addFromInbox: vi.fn(), dismissFromInbox: vi.fn(), turnInboxOn: vi.fn(), changeInboxAddress: vi.fn(), turnInboxOff: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
vi.mock("@/lib/commands/inbox", () => ({ addFromInbox: mocks.addFromInbox, dismissFromInbox: mocks.dismissFromInbox }));
vi.mock("@/lib/email-inbox/inboxes", () => ({ turnInboxOn: mocks.turnInboxOn, changeInboxAddress: mocks.changeInboxAddress, turnInboxOff: mocks.turnInboxOff }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
vi.mock("@/lib/dal/scope", async () => {
  const { orgTestContext } = await import("./support/fake-supabase");
  return { inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG, userId: USER }), fn) };
});

const ROW = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e53";
const INITIAL: InboxActionResult = { ok: false, message: "" };
const access = (role: string) => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "acme", name: "Acme", mode: "live", role } });

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("adding and dismissing an emailed invoice", () => {
  it("asks for records.write, and adds as the session's member with the goods as pressed", async () => {
    mocks.authorize.mockResolvedValue(access("admin"));
    mocks.addFromInbox.mockResolvedValue({ ok: true, message: "Added a payable for Northwind Hosting.", invoiceId: "inv-1" });
    const result = await addInboxEmailAction(INITIAL, form({ inboxEmailId: ROW, goodsReceived: "true" }));

    expect(mocks.authorize).toHaveBeenCalledWith("acme", "records.write");
    expect(mocks.addFromInbox).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: USER, role: "admin", surface: { kind: "console" } }), {
      inboxEmailId: ROW,
      goodsReceived: true,
    });
    expect(result).toEqual({ ok: true, message: "Added a payable for Northwind Hosting." });
  });

  it("dismisses with records.write too", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.dismissFromInbox.mockResolvedValue({ ok: true, message: "Dismissed." });
    expect(await dismissInboxEmailAction(INITIAL, form({ inboxEmailId: ROW }))).toEqual({ ok: true, message: "Dismissed." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "records.write");
  });

  it("answers a refused session in its own words, and a row id that is not one without asking further", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, message: "You cannot do that here." });
    expect(await addInboxEmailAction(INITIAL, form({ inboxEmailId: ROW }))).toEqual({ ok: false, message: "You cannot do that here." });
    mocks.authorize.mockResolvedValue(access("admin"));
    expect(await dismissInboxEmailAction(INITIAL, form({ inboxEmailId: "../x" }))).toMatchObject({ ok: false });
    expect(mocks.dismissFromInbox).not.toHaveBeenCalled();
  });
});

describe("the address", () => {
  it.each([
    ["turns it on", turnOnInboxAction, "turnInboxOn"],
    ["changes it", changeInboxAddressAction, "changeInboxAddress"],
    ["turns it off", turnOffInboxAction, "turnInboxOff"],
  ] as const)("%s for integrations.manage, as the session's member", async (_label, action, call) => {
    mocks.authorize.mockResolvedValue(access("admin"));
    mocks[call].mockResolvedValue({});
    const result = await action(INITIAL, form());
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks[call]).toHaveBeenCalledWith(ORG, USER);
    expect(result.ok).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("says the change did not work, and why only to the log", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.turnInboxOn.mockRejectedValue(new Error("db down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await turnOnInboxAction(INITIAL, form())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    errors.mockRestore();
  });
});
