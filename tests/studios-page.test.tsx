import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenNumbers, SideNumbers } from "@/lib/platform/open-numbers";

vi.mock("server-only", () => ({}));
vi.mock("@/app/studios/actions", () => ({ requestGuidedSetupAction: vi.fn() }));
vi.mock("@/lib/platform/latest-decision", () => ({ readLatestDecision: vi.fn(async () => null) }));
vi.mock("@/lib/platform/open-numbers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/open-numbers")>();
  return { ...actual, readAllTimeOrNull: vi.fn() };
});

import sitemap from "@/app/sitemap";
import StudiosPage, { metadata } from "@/app/studios/page";
import { FAQ, REVIEW_HREF, REVIEW_LABEL } from "@/components/studios/StudiosSections";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";
import { checkGuidedSetupToken } from "@/lib/growth/guided-setup";
import { readLatestDecision } from "@/lib/platform/latest-decision";
import { readAllTimeOrNull } from "@/lib/platform/open-numbers";
import { publicOrigin } from "@/lib/public-origin";

/**
 * /studios, the page for studios that pay contractors per deliverable: its copy, its one call to action into shadow mode,
 * the count of code refusals read from the open numbers (never written into the page), the FAQ, the guided setup form,
 * and its place in the sitemap.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function side(figures: Partial<SideNumbers> = {}): SideNumbers {
  return {
    workspacesOpened: 0, liveWorkspaces: 0, people: 0, payments: 0, usdcPaid: 0, payees: 0, invoicesDecided: 0, milestonesReleased: 0, cycles: 0,
    modelDecisions: 0, policyDepartures: 0, refusedByCode: 0, usdcInWallets: 0, firstPayments: 0, medianMinutesToFirstPayment: null,
    decisionsCarriedOut: null, decisionsEscalated: null, escalationsResolved: null, flagsResolved: null, flagsUpheld: null, invoicesPaidOnArc: null,
    invoicesPaidOnTime: null, invoicesPaidOnTimeUntouched: null, duplicatesCaught: null, verdictsGiven: null, verdictsAgreed: null,
    ...figures,
  };
}

function numbers(customers: number, ours: number): OpenNumbers {
  return {
    generatedAt: "2026-10-10T07:00:00Z",
    sides: { customers: side({ refusedByCode: customers }), ours: side({ refusedByCode: ours }), total: side({ refusedByCode: customers + ours }) },
    daily: [],
    ourPayments: [],
  };
}

function byNetwork(answers: { mainnet: OpenNumbers | null; testnet: OpenNumbers | null }) {
  vi.mocked(readAllTimeOrNull).mockImplementation(async (network) => (network === "arc-mainnet" ? answers.mainnet : answers.testnet));
}

const KEY = crypto.randomBytes(32);

async function render() {
  return renderToStaticMarkup(await StudiosPage());
}

/** The trust section's text. */
function trust(markup: string): string {
  return text(markup.split('aria-labelledby="studios-trust-title"')[1]?.split("</section>")[0] ?? "");
}

beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = `k1:${KEY.toString("base64")}`;
  byNetwork({ mainnet: numbers(0, 3), testnet: numbers(17, 4304) });
  vi.mocked(readLatestDecision).mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.VESTIARION_MASTER_KEYS;
});

describe("/studios", () => {
  it("says who it is for, the headline, how it works and what it promises", async () => {
    const words = text(await render());
    for (const part of [
      "For studios that pay contractors per deliverable.",
      "Check every contractor invoice before you pay it.",
      "An agent compares each invoice with what you agreed and what was delivered, then says pay, wait or stop — and why. You approve.",
      "checked by hand against the brief, the delivery, the amount, and whether it was already paid",
      "At month end they land together.",
      "Add an invoice",
      "Type it, upload the PDF, import a CSV, or forward it by email or Telegram.",
      "The agent decides",
      "Pay now, schedule, hold, or ask for what's missing, with the reason in plain words.",
      "You agree or disagree",
      "In shadow mode you keep paying the way you do today.",
      "No money of yours moves in shadow mode.",
      "Your contractors don't need wallets.",
      "Rules in code refuse a payment the agent wants when it breaks one of your rules.",
      "Every decision is a signed record you can verify in your browser.",
    ]) {
      expect(words, part).toContain(part);
    }
  });

  it("has one call to action, into onboarding with shadow mode ticked, repeated at the end", async () => {
    const markup = await render();
    const ctas = [...markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].filter((match) => text(match[2]) === REVIEW_LABEL);
    expect(ctas).toHaveLength(2);
    for (const [, href] of ctas) expect(href.replace(/&amp;/g, "&")).toBe(REVIEW_HREF);
    expect(new URL(REVIEW_HREF, "https://www.vestiarion.xyz").searchParams.get("shadow")).toBe("1");
    // Signed out, the proxy sends it to sign-in with the whole address as `next`, shadow=1 included.
    expect(requiresSession("/onboarding")).toBe(true);
    expect(loginRedirectFor("/onboarding", "?shadow=1", false)).toBe("/login?next=%2Fonboarding%3Fshadow%3D1");
  });

  it("offers the guided setup as a text link to the form on the page", async () => {
    const markup = await render();
    expect(markup).toMatch(/<a [^>]*href="#guided-setup"[^>]*>Prefer a guided setup\? Ask for one<\/a>/);
    expect(markup).toContain('id="guided-setup"');
  });

  it("reads how often code refused the agent from the open numbers, each network on its own, customers apart", async () => {
    const words = trust(await render());
    expect(words).toContain("Arc testnet: code refused the agent 4,321 times, 17 of them in customers' workspaces.");
    expect(words).toContain("Arc mainnet: code refused the agent 3 times, 0 of them in customers' workspaces.");
    expect(words).toContain("All time, across every workspace, the team's own included, with customers' counted apart.");
    // Never added across networks.
    expect(words).not.toContain("4,324");
    expect(readAllTimeOrNull).toHaveBeenCalledWith("arc-mainnet");
    expect(readAllTimeOrNull).toHaveBeenCalledWith("arc-testnet");
  });

  it("follows the numbers when they change, so no count is written into the page", async () => {
    byNetwork({ mainnet: numbers(0, 0), testnet: numbers(2, 7) });
    const words = trust(await render());
    expect(words).toContain("Arc testnet: code refused the agent 9 times, 2 of them in customers' workspaces.");
    expect(words).toContain("Arc mainnet: code has not had to refuse the agent yet.");
    expect(words).not.toContain("4,321");
    for (const file of ["src/app/studios/page.tsx", "src/components/studios/StudiosSections.tsx"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/refused the agent \d|\b18 times\b/);
    }
  });

  it("leaves out a network it could not read, and the count altogether when it read none", async () => {
    byNetwork({ mainnet: null, testnet: numbers(1, 0) });
    let words = trust(await render());
    expect(words).toContain("Arc testnet: code refused the agent 1 time, 1 of them in customers' workspaces.");
    expect(words).not.toContain("Arc mainnet:");
    byNetwork({ mainnet: null, testnet: null });
    words = trust(await render());
    expect(words).not.toContain("How often code refused the agent");
    expect(words).toContain("Rules in code refuse a payment the agent wants");
  });

  it("links the trust block to the privacy page", async () => {
    const markup = await render();
    expect(markup.split('aria-labelledby="studios-trust-title"')[1]?.split("</section>")[0]).toContain('href="/privacy"');
  });

  it("shows the live open numbers, customers apart from the team, as the landing does", async () => {
    const markup = await render();
    expect(markup).toContain('id="measurements"');
    expect(text(markup)).toContain("Customers' workspaces are counted apart from the team's own");
  });

  it("answers the six questions studios ask first, as true as the code", async () => {
    const words = text(await render());
    expect(FAQ).toHaveLength(6);
    for (const question of [
      "Why would I trust an AI with payments?",
      "Will it move my money automatically?",
      "Do I need USDC?",
      "What if the AI is wrong?",
      "Do my contractors need wallets?",
      "Is it production-ready?",
    ]) {
      expect(words, question).toContain(question);
    }
    expect(words).toContain("Pause agent stops it at any time");
    expect(words).toContain("the CSV export is for spreadsheets and is not signed");
  });

  it("holds the guided setup form: each field, the consent line and a signed token", async () => {
    const markup = await render();
    const words = text(markup);
    for (const label of ["Your name", "Work email", "Studio name", "Studio website", "Contractors paid per month", "How invoices arrive", "Anything else"]) {
      expect(words, label).toContain(label);
    }
    expect(words).toContain("We use these details only to set up a call with you about Vestiarion.");
    expect(markup).toContain('href="/privacy#guided-setup"');
    const token = /name="form_token" value="([^"]+)"/.exec(markup)?.[1] ?? "";
    expect(checkGuidedSetupToken(token, [{ id: "k1", key: KEY }], Date.now() + 5_000)).toBe("ok");
    expect(markup).toMatch(/name="nickname"[^>]*tabindex="-1"|tabindex="-1"[^>]*name="nickname"/i);
  });

  it("still draws the form, with no token, when the master keys cannot be read", async () => {
    delete process.env.VESTIARION_MASTER_KEYS;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const markup = await render();
    expect(markup).toContain('name="form_token" value=""');
    expect(error).toHaveBeenCalledWith("studios: guided setup token not signed", "VESTIARION_MASTER_KEYS is not set");
    error.mockRestore();
  });

  it("names no customer and never plays the product down", async () => {
    const words = text(await render());
    expect(words).not.toMatch(/real money|not real|fictional|\bdemo\b|play money|VND|testimonial/i);
  });

  it("has its own title, description, canonical address and social cards", () => {
    expect(metadata.title).toContain("studios");
    expect(typeof metadata.description === "string" && metadata.description.length > 40).toBe(true);
    expect(metadata.alternates?.canonical).toBe("/studios");
    expect(metadata.openGraph).toMatchObject({ url: "/studios", siteName: "Vestiarion", type: "website" });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", site: "@vestiarionhq" });
  });

  it("is public, and listed in the sitemap", () => {
    expect(requiresSession("/studios")).toBe(false);
    expect(sitemap().map((entry) => entry.url)).toContain(`${publicOrigin()}/studios`);
  });
});
