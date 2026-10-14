import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VerdictControl from "@/components/VerdictControl";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { capabilityOf } from "@/lib/capability";
import type { VerdictView } from "@/lib/verdict-view";

/**
 * A person's verdict on a card (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S3–S5), as server-rendered
 * markup. Its dialogs open in a portal, which a static render leaves closed, so their words are checked against the
 * component's source.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const view = (over: Partial<VerdictView> = {}): VerdictView => ({ entrySeq: 41, agentAction: "ap_pay", given: null, open: true, heldForVerdict: false, ...over });
const control = (over: Partial<VerdictView> = {}) => text(html(<VerdictControl orgSlug="northstar" view={view(over)} />));
const source = readFileSync(path.join(process.cwd(), "src/components/VerdictControl.tsx"), "utf8");

describe("VerdictControl", () => {
  it("asks whether the person agrees with the agent's decision", () => {
    const words = control();
    expect(words).toContain("Do you agree with the agent?");
    expect(words).toContain("Agree");
    expect(words).toContain("Disagree");
    expect(words).not.toContain("Agree and pay");
  });

  it("pays a payment held for the verdict when the person agrees, after a confirmation", () => {
    const words = control({ heldForVerdict: true });
    expect(words).toContain("Agree and pay");
    expect(words).toContain("Disagree");
    expect(source).toContain('title="Agree and pay?"');
    // What it pays is said in the words of the workspace's capability (capability and reasons R5).
    expect(source).toContain("agreeAndPayLine(view.capability)");
  });

  it("offers Agree alone while nothing can be paid, and says why (capability and reasons R5)", () => {
    const off = capabilityOf({ network: "arc-testnet", payments: { state: "off", reason: null }, hold: null, chainMode: "live", shadow: true });
    const words = control({ heldForVerdict: true, capability: off });
    expect(words).not.toContain("Agree and pay");
    expect(words).toContain("Payments are switched off for every workspace. Nothing is paid, moved or locked until they are back on. Agree records your verdict; it can be paid in Approvals later.");
  });

  it("asks why in the same step, and never makes the reason required (capability and reasons R9)", () => {
    expect(source).toContain('label="Why do you disagree?" optional');
    expect(source).not.toMatch(/<Textarea[^>]*required/);
    expect(source).not.toContain('disabled={reason.trim() === ""}');
  });

  it("asks why a person disagrees, and what to do with a payment held for the verdict", () => {
    expect(source).toContain('title="Disagree with the agent?"');
    expect(source).toContain('label="Why do you disagree?"');
    expect(source).toContain("Decide it again later");
    expect(source).toContain("Do not pay it");
    expect(source).toContain("maxLength={280}");
  });

  it("shows the verdict given, with its reason", () => {
    expect(control({ given: { verdict: "agree", reason: null }, open: false })).toBe("You agreed.");
    expect(control({ given: { verdict: "disagree", reason: "Paid on the due date" }, open: false })).toBe("You disagreed: Paid on the due date");
    expect(control({ given: { verdict: "disagree", reason: null }, open: false })).toBe("You disagreed.");
  });

  it("tells someone who may not decide payments that it waits", () => {
    const words = control({ open: false });
    expect(words).toBe("Waits for a person's verdict.");
  });
});

describe("VerdictControl and the payment it agrees to (shadow mode review C1, I2)", () => {
  const payment = { amountUsdc: 96.39, payee: "Dien luc", address: "0x1948aB0000000000000000000000000000c345a0" };

  it("says what agreeing pays, and to which address, and sends that address with it", () => {
    const words = text(html(<VerdictControl orgSlug="northstar" view={view({ heldForVerdict: true, payment })} />));
    expect(words).toContain("Agree and pay");
    expect(words).toContain("Pays 96.39 USDC to Dien luc, at 0x1948aB0000000000000000000000000000c345a0.");
    expect(source).toContain("shownAddress: view.payment?.address ?? undefined");
  });

  it("offers Agree alone, and says why, to someone who may not pay it", () => {
    const words = text(html(<VerdictControl orgSlug="northstar" view={view({ heldForVerdict: true, payment })} payBlocked="You created this invoice" />));
    expect(words).not.toContain("Agree and pay");
    expect(words).toContain("Agree");
    expect(words).toContain("You created this invoice: Agree records your verdict, and another person pays it in Approvals.");
  });
});

describe("verdictView and the payment", () => {
  it("carries the payment the card shows", async () => {
    const { verdictView } = await import("@/lib/verdict-view");
    const entry = { seq: 41, ts: "2026-10-07T10:00:00.000Z", actor: "agent" as const, action: "ap_pay", detail: { invoiceId: "inv-1" } };
    const facts = { shadow: { startedAt: "2026-10-07T00:00:00.000Z" }, given: new Map(), canGive: true };
    const payment = { amountUsdc: 96.39, payee: "Dien luc", address: "0xabc" };
    expect(verdictView("inv-1", [entry], facts, true, payment)?.payment).toEqual(payment);
  });
});
