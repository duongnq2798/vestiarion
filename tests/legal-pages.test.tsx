import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import sitemap from "@/app/sitemap";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import { can, ORG_ROLES, PERMISSIONS, type OrgRole, type Permission } from "@/lib/auth/roles";
import { MAINNET_STARTING_TWO_APPROVALS } from "@/lib/mainnet";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";
import { FIRST_TOUCH_COOKIE, FIRST_TOUCH_DAYS, TAG_KEYS, TAG_MAX } from "@/lib/growth/attribution";
import { CONSENT, MESSAGE_MAX } from "@/lib/growth/guided-setup";
import { REASON_MAX } from "@/lib/decision-reasons";
import { SANDBOX_IDLE_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS } from "@/lib/platform/cleanup";
import { PREVIEW_MAX } from "@/lib/email/customer-wrote";
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
  { path: "/terms", file: "src/app/terms/page.tsx", Page: TermsPage, metadata: termsMetadata, heading: "Terms of use", updated: "2026-10-16" },
  { path: "/privacy", file: "src/app/privacy/page.tsx", Page: PrivacyPage, metadata: privacyMetadata, heading: "Privacy", updated: "2026-10-23" },
] as const;

describe.each(PAGES)("$path", ({ path: route, file, Page, metadata, heading, updated }) => {
  const markup = renderToStaticMarkup(<Page />);

  it("has a title and a description", () => {
    expect(metadata.title).toBeTruthy();
    expect(typeof metadata.description === "string" && metadata.description.length > 20).toBe(true);
    expect(metadata.alternates?.canonical).toBe(route);
  });

  it("renders its heading, the date it was last updated, the site header and the compact footer", () => {
    expect(markup).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
    expect(text(markup)).toContain(`Last updated ${updated}`);
    expect(markup).toMatch(new RegExp(`<time datetime="${updated}">${updated}</time>`, "i"));
    expect(markup).toMatch(/<header[^>]*class="sticky top-0/);
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });

  it("names Arc mainnet and Arc testnet, and points questions at GitHub Issues", () => {
    expect(text(markup)).toContain("Arc mainnet");
    expect(text(markup)).toContain("Arc testnet");
    expect(text(markup)).not.toMatch(/Vestiarion runs on Arc testnet|every payment it makes is a transfer on Arc testnet/);
    expect(markup).not.toContain(">Arc testnet only<");
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
    "real USDC",
    "cannot be taken back",
    "your own wallet or passkey wallet",
    "spending limit contract",
    "recovery phrase",
    "not been audited",
    "lawfully",
  ])("cover %s", (phrase) => {
    expect(body.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it("states the starting figures of a workspace on Arc mainnet as the code writes them", () => {
    const mainnet = source("src/lib/mainnet.ts");
    const budget = mainnet.match(/MAINNET_STARTING_BUDGET = \{ dailyUsdc: (\d+), weeklyUsdc: (\d+) \}/);
    expect(source("src/lib/platform/workspace.ts")).toContain("daily_usdc: MAINNET_STARTING_BUDGET.dailyUsdc");
    expect(budget).not.toBeNull();
    expect(body).toContain(`two approvals above ${MAINNET_STARTING_TWO_APPROVALS} USDC`);
    expect(body).toContain(`${budget?.[1]} USDC a day and ${budget?.[2]} USDC in 7 days`);
  });

  it("names the features that run on Arc testnet only, as the network profiles have them", () => {
    expect(ARC_MAINNET.hostedWallets).toBe(false);
    expect(ARC_TESTNET.hostedWallets).toBe(true);
    expect(ARC_MAINNET.usyc).toBeNull();
    expect(ARC_MAINNET.escrow).toBe(false);
    expect(ARC_MAINNET.swapAdapter).toBeNull();
    // CCTP payouts run on Arc mainnet to Base, from a workspace's own Circle account (mainnet Base payouts B1, B3).
    expect(ARC_MAINNET.cctp).not.toBeNull();
    expect(ARC_MAINNET.faucet).toBeNull();
    expect(ARC_MAINNET.walletTreasury).toBe(true);
    const testnet = text(renderToStaticMarkup(<TermsPage />).split('id="networks"')[1]?.split('id="custody"')[0] ?? "");
    for (const feature of ["hosted wallets", "the USYC reserve", "milestone escrow", "the EURC swap", "Circle's faucet"]) {
      expect(testnet, feature).toContain(feature);
    }
    expect(testnet).toContain("Payouts to other chains run here, and on Arc mainnet to Base and Arbitrum from a workspace's own Circle account.");
  });
});

describe("the privacy page", () => {
  const body = text(renderToStaticMarkup(<PrivacyPage />));

  it("names each service that receives data", () => {
    for (const name of ["Supabase", "Vercel", "Circle", "Resend", "Google Analytics", "Anthropic", "OpenAI", "DeepSeek", "OpenSanctions", "GitHub", "Telegram", "Product Hunt", "Xero", "QuickBooks", "Intuit", "Zoho Books", "HubSpot", "Pipedrive"]) {
      expect(body, name).toContain(name);
    }
  });

  it("states the sandbox cleanup's threshold as the code has it", () => {
    expect(body).toContain(`${SANDBOX_IDLE_DAYS} days`);
  });

  it("states the webhook delivery retention as the code has it", () => {
    expect(body).toContain(`${WEBHOOK_DELIVERY_RETENTION_DAYS} days`);
  });

  it("states how much of a customer's words reach the members' email, as the code has it", () => {
    expect(body).toContain(`at most ${PREVIEW_MAX} characters of what it wrote and no link it wrote`);
  });

  it("names every workspace role", () => {
    for (const role of ORG_ROLES) expect(body.toLowerCase(), role).toContain(role);
  });

  it("says a role does 'also' more only after a role whose every permission it holds", () => {
    const list = renderToStaticMarkup(<PrivacyPage />).split('id="roles"')[1]?.split("</ul>")[0] ?? "";
    const items = [...list.matchAll(/<li>\s*<strong>([a-z]+)<\/strong>:\s*([^<]*)/g)].map((match) => ({ role: match[1] as OrgRole, words: match[2].trim() }));
    expect(items.map((item) => item.role).sort()).toEqual([...ORG_ROLES].sort());
    for (const [index, item] of items.entries()) {
      if (!item.words.startsWith("also")) continue;
      const before = items[index - 1].role;
      for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
        if (can(before, permission)) expect(can(item.role, permission), `${item.role}, listed after ${before}, holds ${permission}`).toBe(true);
      }
    }
  });

  it("says which button choice Google Analytics counts, and the code sends only its name and the redacted path (landing clarity M1)", () => {
    const analytics = source("src/components/analytics/GoogleAnalytics.tsx");
    expect(analytics).toContain('"cta_click", { cta_id: id, page_path: redactPath(window.location.pathname) }');
    for (const phrase of ["cta_click", "hero-try", "Try it on your bills", "Nothing you typed and nothing about you goes with it."]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it("says what Google Analytics is kept from, and the code keeps it from exactly that", () => {
    const analytics = source("src/components/analytics/GoogleAnalytics.tsx");
    expect(analytics).toContain("allow_google_signals: false");
    expect(analytics).toContain("allow_ad_personalization_signals: false");
    expect(analytics).toContain("send_page_view: false");
    const redact = source("src/lib/analytics/redact.ts");
    expect(redact).toContain('"/invite/:token"');
    expect(redact).toContain('"/o/:org"');
    expect(redact).toContain('"/report/:token"');
    for (const phrase of ["/invite/:token", "/report/:token", "/o/:org", "Google signals", "ad personalization", "query string", "origin"]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it("describes the first-touch cookie as the code sets it: its name, the tags, how long, first-party, never an email", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="campaign-cookie"')[1]?.split('id="retention"')[0] ?? "");
    expect(section).toContain(FIRST_TOUCH_COOKIE);
    expect(section).toContain(`${FIRST_TOUCH_DAYS} days`);
    expect(section).toContain(`${TAG_MAX} letters`);
    for (const tag of Object.keys(TAG_KEYS)) expect(section, tag).toContain(tag);
    for (const phrase of ["first-party", "never holds your email address", "without its query", "host of the site", "deleted with the workspace"]) {
      expect(section, phrase).toContain(phrase);
    }
    const cookie = source("src/lib/growth/attribution.ts");
    expect(cookie).toContain('"Path=/", "SameSite=Lax"');
    expect(cookie).not.toMatch(/Domain=/);
  });

  it("says a workspace from a client link keeps the accountant's tags, and the cookie's when the accountant could not be added, as the join action does (accountant client links AC5)", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="campaign-cookie"')[1]?.split('id="retention"')[0] ?? "");
    expect(section).toContain(
      "A workspace opened from an accountant's client link keeps the tags accountant , client_link and accountant_client instead of the cookie's, unless the accountant could not be added: it then keeps the cookie's tags, as any new workspace does."
    );
    expect(section).not.toContain("the cookie is not read for it");
    // As the code does it: the claim writes the accountant's tags, and a claim that fails records the cookie's.
    expect(source("supabase/migrations/0143_accountant_client_links.sql")).toContain("values (p_org_id, 'accountant', 'client_link', 'accountant_client')");
    expect(source("src/app/join/actions.ts")).toContain("if (!accountantAdded) await recordFirstTouch(orgId);");
  });

  it("describes the reasons people give as the code keeps them: what, who sees them, how long, and what deleting does", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="decision-reasons"')[1]?.split('id="retention"')[0] ?? "");
    for (const phrase of [
      "in one line you may leave empty",
      `up to ${REASON_MAX} characters`,
      "your account's id",
      "the version of Vestiarion that asked",
      "signed ledger",
      "owners and admins see the latest ones on Insights, without your name",
      "The Vestiarion team sees the latest ones across workspaces, with the workspace's slug and never your name or email",
      "not shared with anyone else",
      "kept until the workspace is deleted, and deleted with it",
      "In a workspace that stays, a reason stays without your account's id",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    // As migration 0120 keeps them: the reason's length, gone with the workspace, unnamed when the account goes.
    const migration = source("supabase/migrations/0120_decision_reasons.sql");
    expect(migration).toContain("char_length(reason) between 1 and 280");
    expect(migration).toContain("references public.orgs(id) on delete cascade");
    expect(migration).toContain("given_by     uuid references auth.users(id) on delete set null");
    // The team's list names no person, and only the console asks, where it says the team reads it.
    expect(migration.split("growth_decision_reasons(p_since timestamptz) returns jsonb")[1]).not.toMatch(/given_by|email/);
    expect(source("src/lib/commands/payables.ts")).toContain('actor.surface.kind !== "console"');
    // Insights shows them to owners and admins only.
    expect(source("src/app/o/[slug]/insights/page.tsx")).toContain('access.membership.role === "owner" || access.membership.role === "admin"');
  });

  it("describes the guided setup form as the code reads and keeps it: its fields, why, where, who sees it, never shared", () => {
    const markup = renderToStaticMarkup(<PrivacyPage />);
    const section = text(markup.split('id="guided-setup"')[1]?.split('id="retention"')[0] ?? "");
    const form = source("src/components/studios/GuidedSetupForm.tsx");
    for (const field of ['name="name"', 'name="email"', 'name="studio"', 'name="website"', 'name="contractors"', 'name="arrival"', 'name="message"']) {
      expect(form, field).toContain(field);
    }
    for (const phrase of [
      "your name",
      "your work email",
      "your studio's name",
      "its website",
      "how many contractors you pay a month",
      "how invoices reach you",
      `up to ${MESSAGE_MAX} characters`,
      CONSENT,
      "Supabase Postgres database",
      "apart from every workspace",
      "Only the Vestiarion team sees them",
      "not shared with anyone else and not added to any marketing list",
      "vx_ft",
      "never your message",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    // The team's note is sent only where the variable is set, and carries no message.
    const inbound = source("src/lib/growth/inbound.ts");
    expect(inbound).toContain("GROWTH_INBOUND_NOTIFY_EMAIL");
    expect(inbound.split("export function inboundNotice")[1]?.split("\n}\n")[0]).not.toContain("request.message");
    // The cookie section says a request keeps its tags, and the form's consent line links here.
    expect(text(markup.split('id="campaign-cookie"')[1]?.split('id="guided-setup"')[0] ?? "")).toContain(
      "When you ask for a guided setup, those tags are kept with your request too"
    );
    expect(form).toContain('href="/privacy#guided-setup"');
    // Resend's entry names the note.
    expect(text(markup.split("<strong>Resend</strong>")[1] ?? "")).toContain("a short note about each new guided setup request");
  });

  it("describes a treasury in the owner's own wallet on Arc mainnet as the code keeps it: no key, the proof in the ledger, the words never sent", () => {
    const section = text(renderToStaticMarkup(<PrivacyPage />).split('id="wallets"')[1]?.split('id="services"')[0] ?? "");
    for (const phrase of [
      "Arc mainnet or Arc testnet",
      "Vestiarion holds no key to it",
      "the signed ledger keeps the message and the signature",
      "never sent to Vestiarion",
      "created in Vestiarion's Circle account",
      "Vestiarion's server takes no part",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    // The proof goes into the ledger entry, the twelve words are made in the browser, and only public parts are kept there.
    expect(source("src/lib/treasury/wallet-treasury.ts")).toMatch(/detail: \{ by: input\.actorId, address, message: input\.message, signature: input\.signature/);
    expect(source("src/components/treasury/PasskeyTreasurySteps.tsx")).toContain("generateMnemonic(english)");
    expect(source("supabase/migrations/0083_passkey_treasury.sql")).toContain("add column if not exists recovery_address text");
    expect(source("src/lib/inbound-usdc.ts")).toContain("It all runs in the browser");
    // A sandbox whose owner's wallet deployed its contract is kept by the cleanup, as the retention section says.
    expect(source("src/lib/platform/cleanup.ts")).toContain("kept abandoned sandbox with its wallet's contract");
    expect(body).toContain("or if its owner's own wallet deployed its contract");
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

  describe("what a model provider receives, held to the prompts in src/lib/agent/orchestrator.ts and treasury.ts", () => {
    const orchestrator = source("src/lib/agent/orchestrator.ts");
    const keysOf = (body: string) => new Set([...body.matchAll(/^\s*(\w+)(?::|,\s*$)/gm)].map((key) => key[1]));
    /**
     * Each `userPrompt: JSON.stringify({ … })` up to its responseShape, and the payable's
     * `userPrompt: apDecisionPrompt({ … })` up to its schema: the keys each sends, shorthand ones included. The
     * treasury move's question is built by treasuryUserPrompt, up to its responseShape.
     */
    const prompts = [
      ...[...orchestrator.matchAll(/userPrompt: (?:JSON\.stringify|apDecisionPrompt)\(\{([\s\S]*?)(?:responseShape:|\}\),\s*schema: apDecisionSchema)/g)].map((match) => keysOf(match[1])),
      ...[...source("src/lib/agent/treasury.ts").matchAll(/export function treasuryUserPrompt[\s\S]*?JSON\.stringify\(\{([\s\S]*?)responseShape:/g)].map((match) => keysOf(match[1])),
    ];
    const models = body.split("A model provider")[1]?.split("OpenSanctions")[0] ?? "";

    // Structure and the task's own words, not data about the workspace.
    const FRAME = ["task", "invoice", "terms", "counterparty", "treasury", "milestone", "contractor", "economics", "payments", "note", "duplicateNote", "duplicateMatchesTotal"];
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
      purchaseOrderRequired: "whether it needs a purchase order",
      performanceHistory: "performance score",
      addressHistory: "how many workspaces here have paid its address",
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
      bounds: "the most a sweep may take",
      sweepAtMostUsdc: "the most a sweep may take",
      redeemAtMostUsdc: "the most and least a redemption",
      redeemAtLeastUsdc: "the most and least a redemption",
      noSweepUntil: "until when nothing is swept",
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
  it("lists the terms, the privacy page and the page for studios", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${publicOrigin()}/terms`);
    expect(urls).toContain(`${publicOrigin()}/privacy`);
    expect(urls).toContain(`${publicOrigin()}/studios`);
  });
});
