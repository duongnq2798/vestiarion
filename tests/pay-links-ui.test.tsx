import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayLinkAction } from "@/app/actions/pay-links";
import { checkPaymentAction } from "@/app/pay/[token]/actions";
import PayPage from "@/app/pay/[token]/page";
import { PayLinkControl } from "@/components/PayLinkControl";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { requiresSession } from "@/lib/auth/routes";
import { PayLinkError } from "@/lib/platform/pay-links";

/**
 * Pay links in the app and on the public page (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2):
 * making one needs records.write; the page shows only what the client needs (R2) and needs no session; "I have paid"
 * only asks Vestiarion to look (R5). The library is faked; it is tested in tests/pay-links.test.ts.
 */

const { authorizeMock, createMock, checkMock, previewMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  createMock: vi.fn(),
  checkMock: vi.fn(),
  previewMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/platform/pay-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/pay-links")>()),
  createPayLink: createMock,
  checkPayLink: checkMock,
  previewPayLink: previewMock,
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

describe("checkPaymentAction", () => {
  it.each([
    ["received", true, "Received, thank you"],
    ["not_yet", true, "Not seen yet"],
    ["wait", true, "Checked just now"],
    ["invalid", false, "no longer works"],
  ])("answers %s", async (outcome, ok, message) => {
    checkMock.mockResolvedValueOnce(outcome);
    const result = await checkPaymentAction({ ok: false, message: "" }, form({ token: TOKEN }));
    expect(checkMock).toHaveBeenCalledWith(TOKEN);
    expect(result.ok).toBe(ok);
    expect(result.message).toContain(message);
    expect(result.received).toBe(outcome === "received");
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
  it("offers to make a pay link for the receivable", () => {
    const markup = renderToStaticMarkup(<TooltipProvider><PayLinkControl orgSlug="mai" invoiceId={INVOICE} /></TooltipProvider>);
    expect(text(markup)).toContain("Get paid on Arc");
    expect(markup).toContain(`value="${INVOICE}"`);
  });
});
