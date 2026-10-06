import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayLinkAction, setRemindersAction } from "@/app/actions/pay-links";
import { checkPaymentAction } from "@/app/pay/[token]/actions";
import PayPage from "@/app/pay/[token]/page";
import { PayLinkControl, remindersSoFar } from "@/components/PayLinkControl";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { requiresSession } from "@/lib/auth/routes";
import { PayLinkError } from "@/lib/platform/pay-links";

/**
 * Pay links in the app and on the public page (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2):
 * making one needs records.write; the page shows only what the client needs (R2) and needs no session; "I have paid"
 * only asks Vestiarion to look (R5). The library is faked; it is tested in tests/pay-links.test.ts.
 */

const { authorizeMock, createMock, checkMock, previewMock, remindersMock, raiseMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  createMock: vi.fn(),
  checkMock: vi.fn(),
  previewMock: vi.fn(),
  remindersMock: vi.fn(),
  raiseMock: vi.fn(),
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock, runCycleSoon: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/platform/pay-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/pay-links")>()),
  createPayLink: createMock,
  checkPayLink: checkMock,
  previewPayLink: previewMock,
  setReminders: remindersMock,
}));

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const TOKEN = `vxr_${"A".repeat(43)}`;
const PREVIEW = {
  orgId: "org-secret-id", invoiceId: "invoice-secret-id", createdBy: "user-secret-id", orgName: "Mai Studio", clientName: "Acme", amount: 12.5,
  currency: "USDC", dueDate: "2026-10-15", memo: "October retainer", status: "open", payTo: "0x1111111111111111111111111111111111111111", chain: "ARC-TESTNET",
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "u1", email: null }, membership: { orgId: "o1", slug: "mai", name: "Mai Studio", mode: "live", role: "owner" } });
  createMock.mockReset().mockResolvedValue({ token: TOKEN, linkId: "l1" });
  checkMock.mockReset();
  previewMock.mockReset();
  process.env.SITE_URL = "https://www.vestiarion.xyz";
});

describe("createPayLinkAction", () => {
  it("asks for records.write and returns the link", async () => {
    const result = await createPayLinkAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE }));
    expect(authorizeMock).toHaveBeenCalledWith("mai", "records.write");
    expect(createMock).toHaveBeenCalledWith({ actorId: "u1", invoiceId: INVOICE });
    expect(result).toEqual({ ok: true, message: "Pay link ready. Send it to your client.", url: `https://www.vestiarion.xyz/pay/${TOKEN}` });
  });

  it("shows a refusal, and makes nothing for someone refused", async () => {
    createMock.mockRejectedValueOnce(new PayLinkError("closed"));
    expect((await createPayLinkAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE }))).message).toContain("already settled");
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    createMock.mockClear();
    expect(await createPayLinkAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE }))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("setRemindersAction (collections R1)", () => {
  beforeEach(() => {
    remindersMock.mockReset().mockResolvedValue({ madeNewLink: false, replacedLink: false, counterpartyName: "Acme" });
    raiseMock.mockReset();
  });

  it("asks for records.write, turns reminders on and starts a cycle", async () => {
    const result = await setRemindersAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE, on: "true" }));
    expect(authorizeMock).toHaveBeenCalledWith("mai", "records.write");
    expect(remindersMock).toHaveBeenCalledWith({ actorId: "u1", invoiceId: INVOICE, on: true });
    expect(result).toEqual({ ok: true, message: "Reminders on. The agent decides when to remind Acme." });
    expect(raiseMock).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "u1", email: null } }), "reminders_on");
  });

  it("says the link sent before stops working only when one was replaced", async () => {
    remindersMock.mockResolvedValueOnce({ madeNewLink: true, replacedLink: true, counterpartyName: "Acme" });
    expect((await setRemindersAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE, on: "true" }))).message).toBe(
      "Reminders on. The agent decides when to remind Acme, with a new pay link: the one sent before no longer works."
    );
    remindersMock.mockResolvedValueOnce({ madeNewLink: true, replacedLink: false, counterpartyName: "Acme" });
    expect((await setRemindersAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE, on: "true" }))).message).toBe(
      "Reminders on. The agent decides when to remind Acme, with the pay link it just made."
    );
  });

  it("turns them off without a cycle, and shows a refusal", async () => {
    expect(await setRemindersAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE, on: "false" }))).toEqual({ ok: true, message: "The agent no longer reminds Acme." });
    expect(raiseMock).not.toHaveBeenCalled();
    remindersMock.mockRejectedValueOnce(new PayLinkError("no_email"));
    expect((await setRemindersAction({ ok: false, message: "" }, form({ orgSlug: "mai", invoiceId: INVOICE, on: "true" }))).message).toContain("billing email");
  });
});

describe("checkPaymentAction", () => {
  it.each([
    ["received", true, "Received, thank you"],
    ["not_yet", true, "Not seen yet"],
    ["wait", true, "Checked just now"],
    ["invalid", false, "no longer works"],
  ])("answers %s", async (outcome, ok, message) => {
    checkMock.mockResolvedValueOnce({ outcome, network: outcome === "invalid" ? null : "arc-testnet" });
    const result = await checkPaymentAction({ ok: false, message: "" }, form({ token: TOKEN }));
    expect(checkMock).toHaveBeenCalledWith(TOKEN);
    expect(result.ok).toBe(ok);
    expect(result.message).toContain(message);
    expect(result.received).toBe(outcome === "received");
  });

  it("says a payment received on a link on Arc mainnet is recorded there (mainnet copy C1)", async () => {
    checkMock.mockResolvedValueOnce({ outcome: "received", network: "arc-mainnet" });
    const result = await checkPaymentAction({ ok: false, message: "" }, form({ token: TOKEN }));
    expect(result.message).toBe("Received, thank you. The payment is recorded on Arc mainnet.");
  });

  it("answers a failure with a sentence, never a broken page", async () => {
    checkMock.mockRejectedValueOnce(new Error("Supabase returned no data"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkPaymentAction({ ok: false, message: "" }, form({ token: TOKEN }));
    expect(result).toEqual({ ok: false, message: "We could not check just now. Try again in a minute." });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("is the one action of the page, gated by the link itself, never a session or a workspace of its own", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "app", "pay", "[token]", "actions.ts"), "utf8");
    expect([...source.matchAll(/export async function (\w+)/g)].map((m) => m[1])).toEqual(["checkPaymentAction"]);
    expect(source).toMatch(/await checkPayLink\(/);
    expect(source).not.toMatch(/inOrg|withOrg|authorize/);
  });
});

describe("the pay page", () => {
  const render = async () => text(renderToStaticMarkup(<TooltipProvider>{await PayPage({ params: Promise.resolve({ token: TOKEN }) })}</TooltipProvider>));

  it("needs no session", () => {
    expect(requiresSession(`/pay/${TOKEN}`)).toBe(false);
  });

  it("shows who asks, how much, by when, for what, and where to pay, and never the server's ids (R2)", async () => {
    previewMock.mockResolvedValueOnce(PREVIEW);
    const page = await render();
    expect(page).toContain("Mai Studio asks Acme to pay 12.50 USDC");
    expect(page).toContain("2026-10-15");
    expect(page).toContain("October retainer");
    expect(page).toContain("0x1111111111111111111111111111111111111111");
    expect(page).toContain("I have paid");
    for (const secret of ["org-secret-id", "invoice-secret-id", "user-secret-id"]) expect(page).not.toContain(secret);
  });

  it("tells the client to pay on the link's network: Arc mainnet for a link there, footer included (mainnet copy C1, C6)", async () => {
    previewMock.mockResolvedValueOnce({ ...PREVIEW, chain: "ARC" });
    const page = await render();
    expect(page).toContain("From any wallet on Arc mainnet.");
    expect(page).toContain("Signed decisions on Arc mainnet");
    expect(page).not.toContain("Arc testnet");
  });

  it("thanks the client once it is received", async () => {
    previewMock.mockResolvedValueOnce({ ...PREVIEW, status: "received" });
    expect(await render()).toContain("Mai Studio received 12.50 USDC. Thank you.");
  });

  it("names no one for a dead link", async () => {
    previewMock.mockResolvedValueOnce(null);
    expect(await render()).toContain("This link is no longer valid");
  });
});

describe("PayLinkControl", () => {
  const CLIENT = { id: "cp-mai", name: "Mai Studio", hasEmail: true };
  const control = (props: Partial<Parameters<typeof PayLinkControl>[0]> = {}) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <PayLinkControl orgSlug="mai" invoiceId={INVOICE} dueDate="2026-10-10T12:00:00+00:00" client={CLIENT} {...props} />
      </TooltipProvider>
    );
  const VIEW = { url: "https://www.vestiarion.xyz/pay/vxr_" + "a".repeat(43), legacy: false, remindersOnAt: null, deferredUntil: null, sent: [] };

  it("offers to make a pay link for the receivable", () => {
    const markup = control();
    expect(text(markup)).toContain("Get paid on Arc");
    expect(markup).toContain(`value="${INVOICE}"`);
  });

  it("shows a kept link again, to copy, and offers a new one (collections R2)", () => {
    const markup = control({ view: VIEW });
    expect(markup).toContain(`value="${VIEW.url}"`);
    expect(text(markup)).toContain("Copy link");
    expect(text(markup)).toContain("Make a new link");
  });

  it("says a link made before links were kept cannot be shown again", () => {
    expect(text(control({ view: { ...VIEW, url: null, legacy: true } }))).toContain("Make a new link to copy it; the old one then stops working.");
  });

  it("offers reminders with their rules, and turns them off once on (R1)", () => {
    const off = text(control({ view: VIEW }));
    expect(off).toContain("Remind the client by email");
    expect(off).toContain("from 3 days before the due date, at most every 3 days, up to 4 reminders");
    const on = control({ view: { ...VIEW, remindersOnAt: "2026-10-03T06:00:00Z", sent: [{ number: 1, tone: "friendly" as const, sentAt: "2026-10-07T09:00:00Z" }] } });
    expect(text(on)).toContain("Reminders are on. Sent: Oct 7, 2026 (friendly).");
    expect(text(on)).toContain("Turn off reminders");
    expect(on).toContain('name="on" value="false"');
  });

  it("sends a client with no billing email to its row on Counterparties", () => {
    const markup = control({ client: { ...CLIENT, hasEmail: false } });
    expect(text(markup)).toContain("Add Mai Studio's billing email on Counterparties");
    expect(markup).toContain('href="/o/mai/counterparties#counterparty-cp-mai"');
    expect(text(markup)).not.toContain("Remind the client by email");
  });
});

describe("what the reminders did so far", () => {
  const VIEW = { url: null, legacy: false, remindersOnAt: "2026-10-03T06:00:00Z", deferredUntil: null, sent: [] as Array<{ number: number; tone: "friendly" | "firm" | "final"; sentAt: string }> };
  const NOW = Date.parse("2026-10-03T08:00:00Z");

  it("says when the agent starts deciding, before the first reminder may go", () => {
    expect(remindersSoFar(VIEW, "2026-10-10T12:00:00+00:00", "Mai Studio", NOW)).toBe("Reminders are on. None sent yet. The agent decides from Oct 7, 2026, 3 days before the due date.");
  });

  it("says until when the agent waits", () => {
    expect(remindersSoFar({ ...VIEW, deferredUntil: "2026-10-05T08:00:00Z" }, "2026-10-04T00:00:00Z", "Mai Studio", NOW)).toBe(
      "Reminders are on. None sent yet. The agent waits until Oct 5, 2026 before deciding again."
    );
  });

  it("hands the client to a person after the last reminder", () => {
    const sent = [{ number: 4, tone: "final" as const, sentAt: "2026-10-20T09:00:00Z" }];
    expect(remindersSoFar({ ...VIEW, sent }, "2026-10-10T12:00:00+00:00", "Mai Studio", NOW)).toBe("The agent sent its last reminder on Oct 20, 2026. Follow up with Mai Studio yourself.");
  });
});
