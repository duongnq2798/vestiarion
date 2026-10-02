import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import sitemap from "@/app/sitemap";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import { ORG_ROLES } from "@/lib/auth/roles";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";
import { SANDBOX_IDLE_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS } from "@/lib/platform/cleanup";
import { publicOrigin } from "@/lib/public-origin";
import { ISSUES_URL } from "@/lib/site-links";

/**
 * /terms and /privacy (spec §2, F2): public, static pages that say only what
 * the code does. Where a statement is a number or a setting in the code, the
 * test reads it from the code, so the page cannot drift from it unnoticed.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PAGES = [
  { path: "/terms", file: "src/app/terms/page.tsx", Page: TermsPage, metadata: termsMetadata, heading: "Terms of use" },
  { path: "/privacy", file: "src/app/privacy/page.tsx", Page: PrivacyPage, metadata: privacyMetadata, heading: "Privacy" },
] as const;

describe.each(PAGES)("$path", ({ path: route, file, Page, metadata, heading }) => {
  const markup = renderToStaticMarkup(<Page />);

  it("has a title and a description", () => {
    expect(metadata.title).toBeTruthy();
    expect(typeof metadata.description === "string" && metadata.description.length > 20).toBe(true);
    expect(metadata.alternates?.canonical).toBe(route);
  });

  it("renders its heading, the date it was last updated, the site header and the compact footer", () => {
    expect(markup).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
    expect(text(markup)).toContain("Last updated 2026-09-30");
    expect(markup).toMatch(/<time datetime="2026-09-30">2026-09-30<\/time>/i);
    expect(markup).toMatch(/<header[^>]*class="sticky top-0/);
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });

  it("names Arc testnet, and points questions at GitHub Issues", () => {
    expect(text(markup)).toContain("Arc testnet");
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${ISSUES_URL}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
  });

  it("never plays the network down", () => {
    expect(text(markup)).not.toMatch(/real money|not real|fake money|play money|worthless/i);
  });

  it("is static: a plain function, reading no request", () => {
    expect(Page.constructor.name).toBe("Function");
    expect(source(file)).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
  });

  it("needs no session", () => {
    expect(requiresSession(route)).toBe(false);
    expect(loginRedirectFor(route, "", false)).toBeNull();
  });
});

describe("the terms", () => {
  const body = text(renderToStaticMarkup(<TermsPage />));

  it.each([
    "Arc testnet",
    "as is",
    "MIT License",
    "Circle credentials",
    "addresses",
    "guardrails",
    "hosted wallets",
    "faucet",
    "another workspace",
    "approve",
  ])("cover %s", (phrase) => {
    expect(body.toLowerCase()).toContain(phrase.toLowerCase());
  });
});

describe("the privacy page", () => {
  const body = text(renderToStaticMarkup(<PrivacyPage />));

  it("names each service that receives data", () => {
    for (const name of ["Supabase", "Vercel", "Circle", "Resend", "Google Analytics", "Anthropic", "OpenAI", "DeepSeek", "OpenSanctions", "GitHub"]) {
      expect(body, name).toContain(name);
    }
  });

  it("states the sandbox cleanup's threshold as the code has it", () => {
    expect(body).toContain(`${SANDBOX_IDLE_DAYS} days`);
  });

  it("states the webhook delivery retention as the code has it", () => {
    expect(body).toContain(`${WEBHOOK_DELIVERY_RETENTION_DAYS} days`);
  });

  it("names every workspace role", () => {
    for (const role of ORG_ROLES) expect(body.toLowerCase(), role).toContain(role);
  });

  it("says what Google Analytics is kept from, and the code keeps it from exactly that", () => {
    const analytics = source("src/components/analytics/GoogleAnalytics.tsx");
    expect(analytics).toContain("allow_google_signals: false");
    expect(analytics).toContain("allow_ad_personalization_signals: false");
    expect(analytics).toContain("send_page_view: false");
    const redact = source("src/lib/analytics/redact.ts");
    expect(redact).toContain('"/invite/:token"');
    expect(redact).toContain('"/o/:org"');
    for (const phrase of ["/invite/:token", "/o/:org", "Google signals", "ad personalization", "query string", "origin"]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it("says API keys are kept only as a SHA-256 hash, as the code keeps them", () => {
    expect(source("src/lib/platform/api-keys.ts")).toContain('createHash("sha256")');
    expect(body).toContain("SHA-256");
  });

  it("says secrets are encrypted with AES-256-GCM, as the code encrypts them", () => {
    expect(source("src/lib/secrets.ts")).toContain("aes-256-gcm");
    expect(body).toContain("AES-256-GCM");
  });

  it("describes the Delete account button and its rules (spec §6, A2, A3), and no longer asks for an issue to delete an account", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="delete-account"')[1]?.split('id="contact"')[0] ?? "");
    for (const phrase of [
      "Delete account",
      "delete my account",
      "only member",
      "last owner",
      "other members",
      "founding workspace",
      "paused",
      "without your name",
      "signed out",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    expect(section).not.toMatch(/open an issue|no button/i);
    // The phrase the page quotes is the one the code checks.
    expect(source("src/lib/platform/delete-account-phrase.ts")).toContain('"delete my account"');
  });

  it("still points questions at GitHub Issues in Contact", () => {
    const contact = renderToStaticMarkup(<PrivacyPage />).split('id="contact"')[1] ?? "";
    expect(contact).toContain(`href="${ISSUES_URL}"`);
  });

  describe("what a model provider receives, held to the prompts in src/lib/agent/orchestrator.ts", () => {
    const orchestrator = source("src/lib/agent/orchestrator.ts");
    /**
     * Each `userPrompt: JSON.stringify({ … })` up to its responseShape, and the payable's
     * `userPrompt: apDecisionPrompt({ … })` up to its schema: the keys each sends, shorthand ones included.
     */
    const prompts = [...orchestrator.matchAll(/userPrompt: (?:JSON\.stringify|apDecisionPrompt)\(\{([\s\S]*?)(?:responseShape:|\}\),\s*schema: apDecisionSchema)/g)].map((match) =>
      new Set([...match[1].matchAll(/^\s*(\w+)(?::|,\s*$)/gm)].map((key) => key[1]))
    );
    const models = body.split("A model provider")[1]?.split("OpenSanctions")[0] ?? "";

    // Structure and the task's own words, not data about the workspace.
    const FRAME = ["task", "invoice", "terms", "counterparty", "treasury", "milestone", "contractor", "economics", "note", "duplicateNote", "duplicateMatchesTotal"];
    const PHRASES: Record<string, string> = {
      amount: "amount",
      currency: "currency",
      usdcValue: "its value in USDC for an invoice in EURC",
      eurcBalance: "the wallet's EURC balance",
      usdcBalance: "its USDC balance",
      usdcDueWithin7Days: "the USDC due within 7 days",
      swap: "the swap of USDC for EURC that could fund it",
      swapUnavailable: "or why there is none",
      payout: "across chains through CCTP or a Gateway balance with its fee",
      memo: "memo",
      poReference: "purchase order reference",
      goodsReceived: "whether the goods were received",
      dueDate: "due date",
      earlyPayDiscount: "early-payment discount",
      timing: "the payment timing worked out from those",
      scheduledEarlier: "when the agent scheduled the invoice earlier, the date it chose and its reasoning",
      name: "name",
      riskLevel: "risk level",
      paymentLimit: "payment limit",
      performanceHistory: "performance score",
      operatingBalance: "operating balance",
      duplicateMatches: "look like duplicates of it",
      otherInvoiceStatus: "status",
      otherInvoiceDueDate: "due date",
      otherInvoiceAmount: "amount",
      signals: "the signals that matched",
      confidence: "how strong the match is",
      finding: "what the match found",
      title: "title",
      verificationSource: "verification source",
      verification: "how it was verified",
      reserveBalance: "reserve balances",
      recurring: "for one a recurring payment created",
      period: "its period",
      cadence: "how often it repeats",
      usyc: "for a real USYC reserve",
      reserveIsRealUsyc: "that it is real",
      subscriptionsOpen: "whether USYC can be bought now",
      reserveApy: "the reserve's yield",
      upcomingObligationsNext7Days: "the next 7 and 14 days",
      upcomingObligationsNext14Days: "the next 7 and 14 days",
      totalOpenObligations: "the total open obligations",
      daysUntilNextObligation: "the days until the next one is due",
      idleAboveBuffer: "the cash above the required buffer",
      requiredBuffer: "the required buffer",
      expectedHoldDays: "how long it could stay swept",
      projectedYieldUsd: "the projected yield",
      roundTripCostUsd: "the cost of the transfers",
    };

    it("finds the three prompts: an invoice, a milestone and a treasury move", () => {
      expect(prompts).toHaveLength(3);
      expect([...prompts[0]]).toEqual(expect.arrayContaining(["invoice", "goodsReceived", "duplicateMatches"]));
      expect([...prompts[1]]).toEqual(expect.arrayContaining(["milestone", "verificationSource"]));
      expect([...prompts[2]]).toEqual(expect.arrayContaining(["reserveApy", "upcomingObligationsNext14Days"]));
    });

    it("names every field a prompt sends: a new one fails here until the page says it", () => {
      for (const key of prompts.flatMap((keys) => [...keys])) {
        if (FRAME.includes(key)) continue;
        expect(PHRASES, `orchestrator.ts sends ${key}; add it to the privacy page and to PHRASES`).toHaveProperty(key);
        expect(models, key).toContain(PHRASES[key]);
      }
    });

    it("says an invoice decision also receives the reserve balance, now that a later target date can draw on it", () => {
      const invoiceBullet = models.split("for a contractor milestone:")[0];
      expect(invoiceBullet).toContain("the operating balance and the reserve balance");
    });

    it("names each payment timing fact the invoice prompt sends, as timingFacts lists them, and not the policy's answer", () => {
      const facts = orchestrator.split("function timingFacts(")[1]?.split("\n}\n")[0] ?? "";
      const keys = [...facts.matchAll(/^\s+(\w+): timing\.\w+,$/gm)].map((m) => m[1]);
      const TIMING: Record<string, string> = {
        today: "today's date",
        dueOn: "the due date",
        discountValue: "what the discount is worth",
        discountAvailableUntil: "the last day it applies",
        floatValueToDue: "the yield from keeping the cash to the due date",
        targetOn: "the day the written policy would pay on",
        amountDueAtTarget: "the amount due that day",
        earlierObligations: "the total and number of payments that fall due on or before that day",
        shortfall: "whether the cash available by that day falls short of covering this invoice after them",
      };
      expect(keys.sort()).toEqual(Object.keys(TIMING).sort());
      for (const key of keys) expect(models, key).toContain(TIMING[key]);
      expect(models).not.toMatch(/falls? due before/);
      expect(models).not.toContain("would pay on and why");
    });

    it("says the performance history is a score and the counts it is computed from, as counterparty-history.ts has them", () => {
      const history = source("src/lib/agent/counterparty-history.ts");
      const inputs = [...(history.split("export interface CounterpartyHistoryInputs {")[1]?.split("}")[0] ?? "").matchAll(/^\s*(\w+): number;/gm)].map((m) => m[1]);
      const COUNTS: Record<string, string> = {
        paidWithoutIntervention: "paid without intervention",
        informationRequested: "information requests",
        heldOrFlagged: "holds and flags",
        duplicateSubmissions: "duplicate submissions",
        riskTierChanges: "risk tier changes",
        heldByOurPolicy: "holds the workspace's own limits caused",
      };
      expect(inputs.sort()).toEqual(Object.keys(COUNTS).sort());
      for (const input of inputs) expect(models, input).toContain(COUNTS[input]);
      expect(models).not.toContain("payment history");
    });
  });

  it("says a workspace address has the workspace's slug replaced in analytics, as the redaction does", () => {
    expect(body).toContain("a workspace address has the workspace's slug replaced, as /o/:org");
    expect(body).not.toContain("workspace's name replaced");
  });

  it("says the signed ledger keeps an account's id after the account is deleted, and the tombstone who deleted a workspace", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="delete-account"')[1]?.split('id="contact"')[0] ?? "");
    expect(section).toContain("A workspace's signed ledger is append-only, so entries you caused keep your account's id (never your email).");
    expect(section).toContain("tombstone keeps who deleted it");
  });

  it("lists what a deleted workspace's tombstone keeps, as migration 0031 writes it", () => {
    const migration = source("supabase/migrations/0031_delete_org.sql");
    for (const column of ["slug", "name", "deleted_by", "deleted_at", "ledger_entries", "ledger_head_hash", "ledger_signing_key_id"]) {
      expect(migration).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    for (const phrase of ["slug", "name", "who deleted it", "when", "length", "head hash", "signing key"]) {
      expect(body, phrase).toContain(phrase);
    }
  });
});

describe("the sitemap", () => {
  it("lists the terms and the privacy page", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${publicOrigin()}/terms`);
    expect(urls).toContain(`${publicOrigin()}/privacy`);
  });
});
