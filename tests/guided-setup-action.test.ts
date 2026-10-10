import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guided setup request from /studios to the founder dashboard (src/lib/growth/inbound.ts and the action in
 * src/app/studios/actions.ts): a person's request becomes one inbound lead through growth_import_leads, a bot's is thanked
 * and dropped, a refusal names its field, a database failure says so, a duplicate is thanked and left as it was, and the
 * team's note goes only where GROWTH_INBOUND_NOTIFY_EMAIL is set.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  campaigns: new Set<string>(),
  campaignReadFails: false,
  importAnswer: { data: [] as unknown, error: null as { message: string } | null },
  rpcCalls: [] as Array<{ name: string; args: { p_rows: Array<Record<string, unknown>>; p_by: unknown } }>,
  campaignQueries: [] as string[],
  cookie: undefined as string | undefined,
}));

vi.mock("@/lib/dal", () => ({
  platformDb: () => ({
    rpc: async (name: string, args: { p_rows: Array<Record<string, unknown>>; p_by: unknown }) => {
      state.rpcCalls.push({ name, args });
      return state.importAnswer;
    },
    from: (table: string) => {
      if (table !== "growth_campaigns") throw new Error(`${table} is not read here`);
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          state.campaignQueries.push(value);
          return {
            maybeSingle: async () =>
              state.campaignReadFails ? { data: null, error: { message: "permission denied" } } : { data: state.campaigns.has(value) ? { id: value } : null, error: null },
          };
        },
      };
      return query;
    },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "vx_ft" && state.cookie !== undefined ? { name, value: state.cookie } : undefined) }),
}));

import { requestGuidedSetupAction } from "@/app/studios/actions";
import { guidedSetupToken, HONEYPOT_FIELD, INBOUND_SIGNAL, MIN_FILL_MS, TOKEN_FIELD, TOKEN_TTL_MS } from "@/lib/growth/guided-setup";
import { EXPIRED, FAILED, submitGuidedSetup, THANKS, type GuidedSetupDeps } from "@/lib/growth/inbound";
import { X_HANDLE } from "@/lib/site-links";

const KEY = { id: "k1", key: crypto.randomBytes(32) };
const DRAWN = Date.UTC(2026, 9, 10, 12, 0, 0);
const SENT = new Date(DRAWN + 20_000);
const COOKIE = "v=1&s=linkedin&m=dm&c=studios-oct&p=/studios&at=2026-10-09T08:00:00.000Z";

function form(overrides: Record<string, string> = {}, token: string = guidedSetupToken([KEY], DRAWN)): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    [TOKEN_FIELD]: token,
    [HONEYPOT_FIELD]: "",
    name: "Lan Pham",
    email: "lan@northwind.example",
    studio: "Northwind Studio",
    website: "https://northwind.example",
    contractors: "11-30",
    arrival: "email",
    message: "Six illustrators, paid per deliverable.",
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const send = vi.fn(async () => ({ sent: true as const, id: "email-1" }));

function deps(overrides: Partial<GuidedSetupDeps> = {}): GuidedSetupDeps {
  return { firstTouchCookie: null, keys: () => [KEY], now: () => SENT, env: {}, send, ...overrides };
}

const imported = () => state.rpcCalls.filter((call) => call.name === "growth_import_leads");

beforeEach(() => {
  state.campaigns = new Set(["studios-oct"]);
  state.campaignReadFails = false;
  state.importAnswer = { data: ["northwind.example"], error: null };
  state.rpcCalls = [];
  state.campaignQueries = [];
  state.cookie = undefined;
  send.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a person's request", () => {
  it("is written as one inbound lead through growth_import_leads, needing review, and thanked", async () => {
    const result = await submitGuidedSetup(form(), deps());
    expect(result).toEqual({ ok: true, message: THANKS });
    expect(imported()).toHaveLength(1);
    const { p_rows, p_by } = imported()[0].args;
    expect(p_by).toBeNull();
    expect(p_rows).toHaveLength(1);
    expect(p_rows[0]).toMatchObject({
      business_name: "Northwind Studio",
      company_url: "https://northwind.example",
      contact_channel: "website_form",
      contact_handle: "lan@northwind.example",
      source: "inbound",
      segment: "other",
      signal: INBOUND_SIGNAL,
      evidence_date: "2026-10-10",
      campaign_id: null,
      source_detail: "Guided setup form on /studios",
      stage: "discovered",
      dedupe_key: "northwind.example",
      notes: "Name: Lan Pham\nContractors paid a month: 11–30\nInvoices arrive by: Email\nMessage: Six illustrators, paid per deliverable.",
    });
    // growth_import_leads sets needs_review itself; the row never asks for another status.
    expect(p_rows[0]).not.toHaveProperty("review_status");
  });

  it("names the first touch's campaign when it is one the team set up", async () => {
    await submitGuidedSetup(form(), deps({ firstTouchCookie: COOKIE }));
    expect(state.campaignQueries).toEqual(["studios-oct"]);
    expect(imported()[0].args.p_rows[0]).toMatchObject({
      campaign_id: "studios-oct",
      source_detail: "Guided setup form on /studios; first touch: utm_source=linkedin, utm_medium=dm, utm_campaign=studios-oct, landing=/studios",
    });
  });

  it("leaves the campaign empty when no campaign has that id, and keeps the raw tags in source_detail", async () => {
    state.campaigns = new Set();
    await submitGuidedSetup(form(), deps({ firstTouchCookie: COOKIE }));
    expect(imported()[0].args.p_rows[0]).toMatchObject({
      campaign_id: null,
      source_detail: expect.stringContaining("utm_campaign=studios-oct"),
    });
  });

  it("leaves the campaign empty when the campaigns cannot be read, and still saves the lead", async () => {
    state.campaignReadFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await submitGuidedSetup(form(), deps({ firstTouchCookie: COOKIE }))).toEqual({ ok: true, message: THANKS });
    expect(imported()[0].args.p_rows[0].campaign_id).toBeNull();
    expect(error).toHaveBeenCalledWith("guided setup: campaign not read", "permission denied");
  });

  it("asks for no campaign when the first touch carries none", async () => {
    await submitGuidedSetup(form(), deps({ firstTouchCookie: "v=1&s=newsletter" }));
    expect(state.campaignQueries).toEqual([]);
    expect(imported()[0].args.p_rows[0].campaign_id).toBeNull();
  });

  it("reaches the action with the request's own vx_ft cookie", async () => {
    vi.useFakeTimers({ now: SENT });
    process.env.VESTIARION_MASTER_KEYS = `k1:${KEY.key.toString("base64")}`;
    state.cookie = COOKIE;
    try {
      expect(await requestGuidedSetupAction({ ok: false, message: "" }, form())).toEqual({ ok: true, message: THANKS });
    } finally {
      vi.useRealTimers();
      delete process.env.VESTIARION_MASTER_KEYS;
    }
    expect(imported()[0].args.p_rows[0].campaign_id).toBe("studios-oct");
  });
});

describe("a bot's request", () => {
  it.each([
    ["fills the honeypot", () => form({ [HONEYPOT_FIELD]: "Bob" }), SENT],
    ["sends no token", () => form({}, ""), SENT],
    ["sends a token we did not sign", () => form({}, guidedSetupToken([{ id: "x", key: crypto.randomBytes(32) }], DRAWN)), SENT],
    ["submits sooner than a person could", () => form(), new Date(DRAWN + MIN_FILL_MS - 1)],
    ["sends more than the form ever makes", () => form({ message: "x".repeat(5_000) }), SENT],
  ])("is thanked like a person's and writes nothing when it %s", async (_case, build, now) => {
    expect(await submitGuidedSetup(build(), deps({ now: () => now }))).toEqual({ ok: true, message: THANKS });
    expect(state.rpcCalls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a request that cannot be saved", () => {
  it("asks to reload when the page was open more than a day, and writes nothing", async () => {
    expect(await submitGuidedSetup(form(), deps({ now: () => new Date(DRAWN + TOKEN_TTL_MS + 1) }))).toEqual({ ok: false, message: EXPIRED });
    expect(state.rpcCalls).toEqual([]);
  });

  it("refuses an email that is not one, naming the field, and writes nothing", async () => {
    const result = await submitGuidedSetup(form({ email: "lan.northwind.example" }), deps());
    expect(result).toEqual({ ok: false, message: "That email address does not look right.", field: "email" });
    expect(state.rpcCalls).toEqual([]);
  });

  it("refuses a website that is not an http(s) address, naming the field, and writes nothing", async () => {
    const result = await submitGuidedSetup(form({ website: "javascript:alert(1)" }), deps());
    expect(result.ok).toBe(false);
    expect(result.field).toBe("website");
    expect(state.rpcCalls).toEqual([]);
  });

  it("says something went wrong when the database refuses, names X, and logs no personal detail", async () => {
    state.importAnswer = { data: null, error: { message: "connection refused" } };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "team@vestiarion.xyz" } }));
    expect(result).toEqual({ ok: false, message: FAILED });
    expect(FAILED).toContain(X_HANDLE);
    expect(error).toHaveBeenCalledWith("guided setup: lead not saved", "connection refused");
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/lan@northwind|Lan Pham|Northwind/);
    expect(send).not.toHaveBeenCalled();
  });

  it("says something went wrong, rather than dropping the request, when the master keys cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await submitGuidedSetup(
      form(),
      deps({
        keys: () => {
          throw new Error("VESTIARION_MASTER_KEYS is not set");
        },
      })
    );
    expect(result).toEqual({ ok: false, message: FAILED });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("a studio that asked before", () => {
  it("is thanked, and its lead is left as it was: growth_import_leads skips the taken dedupe key", async () => {
    state.importAnswer = { data: [], error: null };
    const result = await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "team@vestiarion.xyz" } }));
    expect(result).toEqual({ ok: true, message: THANKS });
    expect(imported()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the team's note", () => {
  it("goes to GROWTH_INBOUND_NOTIFY_EMAIL with the studio, how many contractors and how invoices arrive, never the message", async () => {
    await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: " team@vestiarion.xyz " } }));
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string; html: string }];
    expect(message.to).toBe("team@vestiarion.xyz");
    expect(message.subject).toBe("Guided setup request: Northwind Studio");
    expect(message.text).toContain("Contractors paid a month: 11–30");
    expect(message.text).toContain("Invoices arrive by: Email");
    expect(message.text).toContain("/admin/growth#approvals");
    expect(`${message.text}${message.html}`).not.toContain("Six illustrators");
    expect(`${message.text}${message.html}`).not.toContain("lan@northwind.example");
  });

  it("escapes what the studio typed in the HTML", async () => {
    await submitGuidedSetup(form({ studio: "<b>Bold</b> & Co" }), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "team@vestiarion.xyz" } }));
    const [message] = send.mock.calls[0] as unknown as [{ html: string }];
    expect(message.html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; Co");
  });

  it("is not sent when the variable is unset or empty", async () => {
    await submitGuidedSetup(form(), deps({ env: {} }));
    await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "  " } }));
    expect(imported()).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("is not sent to a value that is not an email address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "the team" } }));
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("failing to send leaves the person thanked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(async () => ({ sent: false as const, reason: "status 500" }));
    const result = await submitGuidedSetup(form(), deps({ env: { GROWTH_INBOUND_NOTIFY_EMAIL: "team@vestiarion.xyz" }, send: failing }));
    expect(result).toEqual({ ok: true, message: THANKS });
    expect(error).toHaveBeenCalledWith("guided setup: notice not sent", "status 500");
  });
});
