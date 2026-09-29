import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteOrigin } from "@/lib/auth/env";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  DIGEST_MAX_RECIPIENTS,
  DIGEST_SEND_DEADLINE_MS,
  markNotified,
  notifyWaitingDecisions,
  waitingToNotify,
} from "@/lib/notifications/waiting";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/notifications/waiting.ts` against a real supabase-js client whose
 * network is a recorder, the same shape as `tests/approvals.test.ts` and
 * `tests/members.test.ts`: a real organization scope over the recorded fake,
 * with a real ledger key, so `appendLedgerEntry` really signs. `org_members`
 * is answered by the fake, so the real `listMembers` runs; `@/lib/email/send`
 * is stubbed so the tests control whether email is configured and whether
 * each send succeeds.
 */

const { sendEmailMock, emailSettingsMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  emailSettingsMock: vi.fn(),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock, emailSettingsFromEnv: emailSettingsMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const NEW_ID = "018f8ce0-1557-7b54-a931-4d777f6bc001";
const TOLD_ID = "018f8ce0-1557-7b54-a931-4d777f6bc002";
const ESCALATED_ID = "018f8ce0-1557-7b54-a931-4d777f6bc003";
const OLD_ESCALATION_ID = "018f8ce0-1557-7b54-a931-4d777f6bc004";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SETTINGS = { apiKey: "test-resend-key", from: "Vestiarion <no-reply@vestiarion.xyz>" };

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
const savedSiteUrl = process.env.SITE_URL;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  process.env.SITE_URL = "https://tests.vestiarion.xyz";
  emailSettingsMock.mockReturnValue(SETTINGS);
  sendEmailMock.mockResolvedValue({ sent: true, id: "email-1" });
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
  sendEmailMock.mockReset();
  emailSettingsMock.mockReset();
  vi.restoreAllMocks();
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NEW_ID,
    amount: "150.5",
    status: "held",
    agent_reasoning: "Held for manual review: over the daily limit.",
    notified_at: null,
    escalated_at: null,
    counterparties: { name: "Acme Supplies" },
    ...overrides,
  };
}

/** Four waiting payables: new, told already, escalated since, and escalated before it was told. */
const MIXED_INVOICES = [
  invoiceRow(),
  invoiceRow({ id: TOLD_ID, notified_at: "2026-09-28T00:00:00Z" }),
  invoiceRow({ id: ESCALATED_ID, status: "flagged", notified_at: "2026-09-27T00:00:00Z", escalated_at: "2026-09-28T12:00:00Z" }),
  invoiceRow({ id: OLD_ESCALATION_ID, status: "awaiting_info", notified_at: "2026-09-28T12:00:00Z", escalated_at: "2026-09-27T00:00:00Z" }),
];

interface MemberFixture { user_id: string; email: string; role: string; notify: boolean }

function member(n: number, role: string, notify = true, email = `member${String(n).padStart(2, "0")}@example.com`): MemberFixture {
  return { user_id: `0b6c1c9e-4a4f-4a7e-9b1e-0000000000${String(n).padStart(2, "0")}`, email, role, notify };
}

/** PostgREST as `waiting.ts` meets it: invoices, `orgs`, `org_members`, `memberships`, and `append_ledger_entry`. */
function waitingFake(options: {
  invoices?: unknown[];
  invoiceRead?: FakeReply;
  invoicePatch?: FakeReply;
  members?: MemberFixture[];
  ledgerFails?: boolean;
  events?: string[];
} = {}) {
  const members = options.members ?? [member(1, "owner")];
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      return options.invoiceRead ?? { body: options.invoices ?? [invoiceRow()] };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") {
      options.events?.push("mark");
      return options.invoicePatch ?? { body: [] };
    }
    if (request.path === "/rest/v1/rpc/org_members") {
      return { body: members.map(({ user_id, email, role }) => ({ user_id, email, role, joined_at: "2026-09-01T00:00:00Z" })) };
    }
    if (request.path === "/rest/v1/memberships" && request.method === "GET") {
      return { body: members.map(({ user_id, notify }) => ({ user_id, notify_email: notify })) };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      options.events?.push("ledger");
      if (options.ledgerFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "system", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
function patches(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");
}
function recipients(): string[] {
  return sendEmailMock.mock.calls.map(([message]) => (message as { to: string }).to);
}

describe("waitingToNotify", () => {
  it("reads waiting payables in due order, and keeps the new and the escalated-since ones", async () => {
    const { fake, run } = waitingFake({ invoices: MIXED_INVOICES });

    const waiting = await run(() => waitingToNotify());

    expect(waiting).toEqual([
      {
        id: NEW_ID, counterpartyName: "Acme Supplies", amount: 150.5, status: "held",
        reasoning: "Held for manual review: over the daily limit.", escalated: false,
      },
      {
        id: ESCALATED_ID, counterpartyName: "Acme Supplies", amount: 150.5, status: "flagged",
        reasoning: "Held for manual review: over the daily limit.", escalated: true,
      },
    ]);

    const [read] = fake.requests.filter((r) => r.path === "/rest/v1/invoices");
    expect(read.params.get("select")).toBe("id,amount,status,agent_reasoning,notified_at,escalated_at,counterparties(name)");
    expect(read.params.get("direction")).toBe("eq.payable");
    // Paid, rejected and every other status never reach the selection at all.
    expect(read.params.get("status")).toBe("in.(held,flagged,awaiting_info)");
    expect(read.params.get("order")).toBe("due_date.asc");
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("does not call a never-notified invoice escalated, even with an escalation on it", async () => {
    const { run } = waitingFake({ invoices: [invoiceRow({ escalated_at: "2026-09-28T00:00:00Z" })] });

    const waiting = await run(() => waitingToNotify());

    expect(waiting.map((invoice) => [invoice.id, invoice.escalated])).toEqual([[NEW_ID, false]]);
  });
});

describe("markNotified", () => {
  it("stamps notified_at on exactly the given invoices, in scope", async () => {
    const { fake, run } = waitingFake();
    const at = new Date("2026-09-29T06:00:00.000Z");

    await run(() => markNotified([NEW_ID, ESCALATED_ID], at));

    const [patch] = patches(fake.requests);
    expect(patch.body).toEqual({ notified_at: "2026-09-29T06:00:00.000Z" });
    expect(patch.params.get("id")).toBe(`in.(${NEW_ID},${ESCALATED_ID})`);
    expect(patch.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("sends nothing for no invoices", async () => {
    const { fake, run } = waitingFake();
    await run(() => markNotified([]));
    expect(patches(fake.requests)).toHaveLength(0);
  });
});

describe("notifyWaitingDecisions", () => {
  it("returns zeros and reads no members when nothing waits", async () => {
    const { fake, run } = waitingFake({ invoices: [] });

    await expect(run(() => notifyWaitingDecisions())).resolves.toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rpcBodies(fake.requests, "org_members")).toHaveLength(0);
  });

  it("emails each owner, admin and approver who has the switch on, one message each", async () => {
    const { fake, run } = waitingFake({
      invoices: MIXED_INVOICES,
      members: [
        member(1, "viewer"),
        member(2, "approver", true, "b-approver@example.com"),
        member(3, "admin", false, "admin-off@example.com"),
        member(4, "owner", true, "z-owner@example.com"),
        member(5, "admin", true, "a-admin@example.com"),
        member(6, "approver", true, "a-approver@example.com"),
      ],
    });

    const result = await run(() => notifyWaitingDecisions());

    expect(result).toEqual({ sent: 4, failed: 0, invoices: 2 });
    // Owner, then admin, then approver; by address within a role. No viewer, nobody with the switch off.
    expect(recipients()).toEqual(["z-owner@example.com", "a-admin@example.com", "a-approver@example.com", "b-approver@example.com"]);

    const messages = sendEmailMock.mock.calls.map(([message]) => message as { to: string; subject: string; html: string; text: string });
    // The same digest to each, each message addressed to one person, and sent with the configured settings.
    for (const message of messages) {
      expect(message.subject).toBe("2 payments need a decision in Northstar");
      expect(message.text).toContain(`${siteOrigin()}/o/northstar/approvals`);
      expect(message.html).not.toContain("example.com");
      expect(message.text).not.toContain("example.com");
    }
    expect(sendEmailMock.mock.calls.every(([, settings]) => settings === SETTINGS)).toBe(true);

    const [switches] = fake.requests.filter((r) => r.path === "/rest/v1/memberships");
    expect(switches.params.get("select")).toBe("user_id,notify_email");
    expect(switches.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(rpcBodies(fake.requests, "org_members")).toEqual([{ p_org_id: ORG }]);
  });

  it("marks the included invoices after the sends, and records ids and counts only", async () => {
    const events: string[] = [];
    sendEmailMock.mockImplementation(async (message: { to: string }) => {
      events.push("send");
      return message.to === "member02@example.com" ? { sent: false, reason: "status 500" } : { sent: true, id: "e" };
    });
    const { fake, run } = waitingFake({ invoices: MIXED_INVOICES, members: [member(1, "owner"), member(2, "approver")], events });

    const result = await run(() => notifyWaitingDecisions());

    expect(result).toEqual({ sent: 1, failed: 1, invoices: 2 });
    expect(events).toEqual(["send", "send", "mark", "ledger"]);
    const [patch] = patches(fake.requests);
    expect(patch.params.get("id")).toBe(`in.(${NEW_ID},${ESCALATED_ID})`);

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      p_actor: "system",
      p_domain: "system",
      p_action: "notification_sent",
      p_summary: "Told 1 member(s) that 2 payment(s) need a decision",
      p_detail: { invoiceIds: [NEW_ID, ESCALATED_ID], escalatedIds: [ESCALATED_ID], recipients: 1, failed: 1 },
    });
    expect(JSON.stringify(appends)).not.toContain("@");
  });

  it("marks nothing, and records nothing, when every send fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmailMock.mockResolvedValue({ sent: false, reason: "status 500" });
    const { fake, run } = waitingFake({ members: [member(1, "owner"), member(2, "admin")] });

    const result = await run(() => notifyWaitingDecisions());

    expect(result).toEqual({ sent: 0, failed: 2, invoices: 1 });
    expect(error).toHaveBeenCalledWith("notifications: every send failed", 2, ORG);
    expect(patches(fake.requests)).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("sends and marks nothing when email is not configured, and says so once", async () => {
    emailSettingsMock.mockReturnValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fake, run } = waitingFake();

    const result = await run(() => notifyWaitingDecisions());

    expect(result).toEqual({ sent: 0, failed: 0, invoices: 1 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(patches(fake.requests)).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("notifications: email not configured", ORG);
  });

  it(`sends to at most ${DIGEST_MAX_RECIPIENTS} members, owners first, and logs how many were skipped`, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const approvers = Array.from({ length: 30 }, (_, i) => member(i + 10, "approver"));
    const { run } = waitingFake({ members: [...approvers, member(1, "owner", true, "zz-owner@example.com")] });

    const result = await run(() => notifyWaitingDecisions());

    expect(result.sent).toBe(DIGEST_MAX_RECIPIENTS);
    expect(recipients()[0]).toBe("zz-owner@example.com");
    expect(recipients()).toHaveLength(25);
    expect(warn).toHaveBeenCalledWith("notifications: recipients over the cap, skipped", 6, ORG);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("@");
  });

  it("never throws: a failed invoice read is logged with the workspace id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = waitingFake({ invoiceRead: { status: 500, body: { message: "database unavailable" } } });

    await expect(run(() => notifyWaitingDecisions())).resolves.toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("notifications: digest failed", ORG, "database unavailable");
  });

  it("never throws: a failed mark after the sends still returns the counts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, run } = waitingFake({ invoicePatch: { status: 500, body: { message: "update refused" } } });

    await expect(run(() => notifyWaitingDecisions())).resolves.toEqual({ sent: 1, failed: 0, invoices: 1 });
    // Counts only, never an address, so the duplicate the next cycle sends can be traced.
    expect(error).toHaveBeenCalledWith("notifications: marking failed after the sends", ORG, { recipients: 1, failed: 0 }, "update refused");
    expect(JSON.stringify(error.mock.calls)).not.toContain("@");
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  describe("with a clock", () => {
    const READ_AT = new Date("2026-09-29T06:00:00.000Z");
    beforeEach(() => {
      // Only Date is faked: the recorded fake and supabase-js still resolve on real timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(READ_AT);
    });
    afterEach(() => vi.useRealTimers());

    /** Each send takes `ms` of the clock. */
    function sendsTaking(ms: number) {
      sendEmailMock.mockImplementation(async () => {
        vi.setSystemTime(new Date(Date.now() + ms));
        return { sent: true, id: "e" };
      });
    }

    it("stamps notified_at with the time the invoices were read, not the time the sends finished", async () => {
      sendsTaking(5_000);
      const { fake, run } = waitingFake({ members: [member(1, "owner"), member(2, "admin")] });

      await run(() => notifyWaitingDecisions());

      // An escalation that lands during the sends is later than this, so it is news again next cycle.
      const [patch] = patches(fake.requests);
      expect(patch.body).toEqual({ notified_at: READ_AT.toISOString() });
    });

    it(`stops sending once the digest has taken ${DIGEST_SEND_DEADLINE_MS / 1000} s, counts the rest as failed, and still marks`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      sendsTaking(25_000);
      const { fake, run } = waitingFake({
        members: [member(1, "owner"), member(2, "admin"), member(3, "approver"), member(4, "approver"), member(5, "approver")],
      });

      const result = await run(() => notifyWaitingDecisions());

      // Sends start at 0 s, 25 s and 50 s; at 75 s the deadline has passed, so the last two are never sent.
      expect(result).toEqual({ sent: 3, failed: 2, invoices: 1 });
      expect(recipients()).toEqual(["member01@example.com", "member02@example.com", "member03@example.com"]);
      expect(warn).toHaveBeenCalledWith("notifications: send deadline passed, not sent", 2, ORG);
      expect(patches(fake.requests)).toHaveLength(1);
      expect(rpcBodies(fake.requests, "append_ledger_entry")[0]).toMatchObject({ p_detail: { recipients: 3, failed: 2 } });
    });
  });

  it("still marks and reports the sends when the ledger append fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, run } = waitingFake({ ledgerFails: true });

    await expect(run(() => notifyWaitingDecisions())).resolves.toEqual({ sent: 1, failed: 0, invoices: 1 });
    expect(patches(fake.requests)).toHaveLength(1);
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "notification_sent", ORG);
  });

  it("never throws outside an organization's scope", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyWaitingDecisions()).resolves.toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(error).toHaveBeenCalledWith("notifications: digest failed", "no organization in scope", expect.any(String));
  });
});
