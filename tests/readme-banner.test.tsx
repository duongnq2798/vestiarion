import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import ReadmeBannerPage, { dynamic, metadata } from "@/app/docs-shots/readme-banner/page";
import { README_BANNER_BILL as BILL } from "@/app/docs-shots/readme-banner-facts";
import { Hero } from "@/components/landing/Hero";
import { pngSize } from "@/lib/docs/screenshots";
import type { TeamJourney, TeamJourneyEvent } from "@/lib/team-journey";

/**
 * The README banner and the GitHub social preview (/docs-shots/readme-banner, `npm run readme:banner`): the landing
 * hero's message and its recorded team bill, from the dated facts in readme-banner-facts.ts, in the hero's own words,
 * answered only where DOCS_SCREENSHOTS=1 is set; the README says in its alt text what the picture shows, and both
 * pictures are on disk at their sizes.
 */

const ROOT = process.cwd();
const words = (markup: string) =>
  markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = () => renderToStaticMarkup(ReadmeBannerPage());

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/readme-banner", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    expect(render).toThrow("NEXT_NOT_FOUND");
  });

  it("reads the flag per request and is never indexed", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the hero's message and the recorded team bill, and nothing else: no workspace address, no vendor, no link", () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const markup = render();
    expect(words(markup)).toBe(
      [
        "Vestiarion",
        "For small businesses with work to do",
        "Your AI agent for bills and payments",
        "Every bill. A clear way through.",
        "Vestiarion team workspace Arc mainnet",
        "Recorded team bill Paid",
        "1 USDC",
        "01 Agent decided Entry #4641",
        "Schedule for Oct 22: no early-payment discount, keeping the cash free until it is due.",
        "CCTP fee: 0.055 USDC to Base, on top",
        "02 Code held it Entry #4641",
        "First payment to a new address needs a second look.",
        "03 A person approved Entry #4643",
        "Paid on Base",
        "Payment confirmation recorded 19 Oct 2026, 10:31:44 UTC",
        "Built on Arc and Circle",
        "Works with Xero, QuickBooks Online, HubSpot, Pipedrive, Slack, Telegram",
      ].join(" ")
    );
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("/o/");
    expect(markup).not.toMatch(/0x[0-9a-f]{8}/i);
    expect(markup).not.toMatch(/<img\b/);
    // One frame, exactly the size the script photographs, and the one h1.
    expect(markup.match(/data-docs-shot="readme-banner"/g)).toHaveLength(1);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
  });

  it("draws its facts from the dated snapshot of entries #4641 and #4643", () => {
    expect(BILL).toMatchObject({
      workspace: "Vestiarion team workspace",
      network: "arc-mainnet",
      amount: 1,
      currency: "USDC",
      check: { seq: 4641, recordedAt: "2026-10-19T10:30:53Z", action: "ap_schedule" },
      decision: { payOn: "2026-10-22", reason: "no_early_payment_discount" },
      hold: { seq: 4641 },
      rule: "counterparty.new_payee",
      approval: { seq: 4643, recordedAt: "2026-10-19T10:31:47Z", action: "approval_paid" },
      payment: { route: "cctp", destination: "BASE", feeUsdc: 0.055026, confirmationRecordedAt: "2026-10-19T10:31:44Z" },
    });
  });

  it("says each step in the words the landing hero uses for the same bill", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    // The hero takes a whole journey; the ledger links are stand-ins here, as the banner shows none of them.
    const link = { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null };
    const event = (recorded: { seq: number; recordedAt: string; action: string }): TeamJourneyEvent => ({ ...recorded, link });
    const journey: TeamJourney = {
      amount: BILL.amount,
      currency: BILL.currency,
      network: BILL.network,
      status: BILL.status,
      received: null,
      check: event(BILL.check),
      hold: event(BILL.hold),
      approval: event(BILL.approval),
      record: event(BILL.approval),
      observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null },
      rule: BILL.rule,
      decision: BILL.decision,
      payment: {
        route: BILL.payment.route,
        confirmationRecordedAt: BILL.payment.confirmationRecordedAt,
        source: { chain: "ARC", hash: BILL.payment.burnTxHash, url: `https://arcscan.app/tx/${BILL.payment.burnTxHash}` },
        destination: { chain: "BASE", hash: BILL.payment.mintTxHash, url: `https://basescan.org/tx/${BILL.payment.mintTxHash}` },
        feeUsdc: BILL.payment.feeUsdc,
      },
      publicKeys: {},
    };
    const complete = async (node: ReactElement) => {
      const stream = await renderToReadableStream(node);
      await stream.allReady;
      return new Response(stream).text();
    };
    const hero = words(await complete(<Hero journey={Promise.resolve({ direct: null, base: journey })} />));
    const card = render().match(/<figure\b[\s\S]*?<\/figure>/)?.[0] ?? "";
    // Every run of text the banner's card shows but its step numbers, each as the hero says it.
    const runs = card
      .replace(/<!--[\s\S]*?-->/g, "")
      .split(/<[^>]+>/)
      .map((run) => run.replace(/\s+/g, " ").trim())
      .filter((run) => run && !/^0\d$/.test(run));
    expect(runs.length).toBeGreaterThanOrEqual(15);
    for (const run of runs) expect(hero, run).toContain(run);
  });
});

describe("the README's banner", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const alt = /<img src="docs\/assets\/readme-banner\.png" alt="([^"]+)" width="100%">/.exec(readme)?.[1] ?? "";

  it("says what the picture shows", () => {
    for (const phrase of [
      "Your AI agent for bills and payments",
      "Every bill. A clear way through.",
      "Vestiarion team workspace on Arc mainnet",
      "1 USDC",
      "entry #4641",
      "entry #4643",
      "Paid on Base",
      "19 Oct 2026, 10:31:44 UTC",
      "Built on Arc and Circle",
      "Xero, QuickBooks Online, HubSpot, Pipedrive, Slack and Telegram",
    ]) {
      expect(alt).toContain(phrase);
    }
  });

  it("is 2560 x 1280, and the social preview 1280 x 640 and under GitHub's 1 MB", () => {
    const banner = readFileSync(path.join(ROOT, "docs/assets/readme-banner.png"));
    expect(pngSize(banner)).toEqual({ width: 2560, height: 1280 });
    const preview = path.join(ROOT, "docs/assets/social-preview.png");
    expect(pngSize(readFileSync(preview))).toEqual({ width: 1280, height: 640 });
    expect(statSync(preview).size).toBeLessThan(1024 * 1024);
  });

  it("is photographed by an npm script, into both files", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["readme:banner"]).toBe("node scripts/docs-screenshots.mjs --readme-banner");
    const script = readFileSync(path.join(ROOT, "scripts/docs-screenshots.mjs"), "utf8");
    for (const piece of ['args.includes("--readme-banner")', 'route: "readme-banner"', "docs/assets/readme-banner.png", "docs/assets/social-preview.png", "maxBytes: 1024 * 1024"]) {
      expect(script).toContain(piece);
    }
  });
});
