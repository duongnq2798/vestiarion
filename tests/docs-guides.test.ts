import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "@/lib/docs/content";
import { GoLiveError, type GoLiveErrorCode } from "@/lib/platform/go-live";

/**
 * The user guides quote the app: every button, field, heading and message
 * they name is the app's own text (getting-started design G3). Each quoted
 * string is listed here with the source file it comes from, and must appear,
 * character for character, in both the guide and that file, so renaming a
 * button in the app fails this test until the guide says the new name.
 */

type GuideSlug = "guides/go-live" | "guides/first-payment";

const PANEL = "src/components/GoLivePanel.tsx";
const GO_LIVE_ACTIONS = "src/app/actions/go-live.ts";
const APP_NAV = "src/components/vx/nav.ts";
const PAUSE = "src/components/AgentPauseControl.tsx";
const RUN = "src/components/AgentControlsClient.tsx";
const COUNTERPARTY_FORM = "src/components/intake/CounterpartyIntake.tsx";
const COUNTERPARTIES_PAGE = "src/app/o/[slug]/counterparties/page.tsx";
const INVOICE_FORM = "src/components/intake/InvoiceIntake.tsx";
const INVOICES_PAGE = "src/app/o/[slug]/invoices/page.tsx";
const INTAKE_ACTIONS = "src/app/actions/intake.ts";
const ORCHESTRATOR = "src/lib/agent/orchestrator.ts";
const CONSOLE_PAGE = "src/app/o/[slug]/console/page.tsx";
const DECISION_CARD = "src/components/vx/DecisionCard.tsx";
const PRIMITIVES = "src/components/vx/Primitives.tsx";
const APPROVAL_CARD = "src/components/ApprovalCard.tsx";
const APPROVALS_PAGE = "src/app/o/[slug]/approvals/page.tsx";
const VERIFY_BADGE = "src/components/VerifyLedgerBadge.tsx";
const AUDIT_PAGE = "src/app/o/[slug]/audit/page.tsx";
const ADDRESS_CONTROLS = "src/components/intake/CounterpartyAddressEdit.tsx";
const ADDRESS_LIBRARY = "src/lib/counterparty-address.ts";

/** Each guide's quoted UI strings, as `[text, the file it must appear in]`. */
const QUOTED: Record<GuideSlug, Array<readonly [string, string]>> = {
  "guides/go-live": [
    ["Settings", APP_NAV],
    ["An owner can connect Circle and take this workspace live from here.", PANEL],
    ["Choose where the wallets live", PANEL],
    ["A testnet wallet, no Circle account needed", PANEL],
    ["Use a Vestiarion testnet wallet", PANEL],
    ["Hosted by Vestiarion · Arc testnet", PANEL],
    ["This workspace will use a Vestiarion testnet wallet; create its treasury wallets next.", GO_LIVE_ACTIONS],
    ["Connect your Circle account", PANEL],
    ["Connect your own Circle account", PANEL],
    ["API key", PANEL],
    ["Entity secret", PANEL],
    ["The one registered for developer-controlled wallets.", PANEL],
    ["Connect Circle", PANEL],
    ["Circle is connected.", GO_LIVE_ACTIONS],
    ["Replace Circle credentials", PANEL],
    ["Create treasury wallets", PANEL],
    ["Treasury wallets created:", GO_LIVE_ACTIONS],
    ["Every account already has a wallet.", GO_LIVE_ACTIONS],
    ["Counterparties are paid only at a real address.", PANEL],
    ["Fund the operating wallet, then go live", PANEL],
    ["Operating wallet", PANEL],
    ["select Arc Testnet, and paste this address", PANEL],
    ["USDC on chain:", PANEL],
    ["Refresh", PANEL],
    ["Going live cannot be undone from here; pausing the agent stops it paying.", PANEL],
    ["Take this workspace live?", PANEL],
    ["Real testnet USDC moves when the agent pays.", PANEL],
    ["The agent runs every 6 hours on its own.", PANEL],
    ["The workspace is no longer deleted when inactive.", PANEL],
    ["To stop it later, pause the agent from the console.", PANEL],
    ["This workspace is live.", GO_LIVE_ACTIONS],
    ["Live · paying on Arc testnet", PANEL],
    ["Live · hosted testnet wallet on Arc", PANEL],
    ["Connect your own Circle account instead", PANEL],
    ["To use your own Circle account, start a new workspace.", PANEL],
    ["Go live", PANEL],
    ["Treasury", APP_NAV],
    ["Run cycle now", RUN],
    ["Approvals", APP_NAV],
    ["Pause agent", PAUSE],
    ["Resume agent", PAUSE],
    ["Could not read the balance from Circle; try again.", GO_LIVE_ACTIONS],
    ["Something went wrong; try again.", GO_LIVE_ACTIONS],
  ],
  "guides/first-payment": [
    ["Counterparties", APP_NAV],
    ["Add counterparty", COUNTERPARTIES_PAGE],
    ["Only an owner or admin of this workspace can add counterparties.", COUNTERPARTIES_PAGE],
    ["Legal or trading name", COUNTERPARTY_FORM],
    ["Payment limit (USDC)", COUNTERPARTY_FORM],
    ["ARC-TESTNET", COUNTERPARTY_FORM],
    ["Payment address", COUNTERPARTY_FORM],
    ["Optional until payment setup", COUNTERPARTY_FORM],
    ["Jurisdiction", COUNTERPARTY_FORM],
    ["Add and screen", COUNTERPARTY_FORM],
    ["added and screened:", INTAKE_ACTIONS],
    ["A payment to a counterparty without one is held for review.", PANEL],
    ["AP / AR", APP_NAV],
    ["Invoice intake", INVOICES_PAGE],
    ["Enter one invoice", INVOICES_PAGE],
    ["Import CSV", INVOICES_PAGE],
    ["Direction", INVOICE_FORM],
    ["Payable", INVOICE_FORM],
    ["Amount (USDC)", INVOICE_FORM],
    ["Due date", INVOICE_FORM],
    ["Memo", INVOICE_FORM],
    ["PO reference", INVOICE_FORM],
    ["Goods or services received", INVOICE_FORM],
    ["Add invoice", INVOICE_FORM],
    ["Invoice added for", INTAKE_ACTIONS],
    ["The agent will evaluate this invoice on the next cycle.", INVOICE_FORM],
    ["Treasury", APP_NAV],
    ["Run cycle now", RUN],
    ["Cycle complete at", ORCHESTRATOR],
    ["Stopped", CONSOLE_PAGE],
    ["Payables", INVOICES_PAGE],
    ["Agent’s reasoning", DECISION_CARD],
    ["Settled on Arc", PRIMITIVES],
    ["Held for you", PRIMITIVES],
    ["Refused by guardrail", PRIMITIVES],
    ["Blocked by code, not by the model", DECISION_CARD],
    ["audit #", DECISION_CARD],
    ["Approvals", APP_NAV],
    ["Nothing is waiting for a decision.", APPROVALS_PAGE],
    ["Edit address", ADDRESS_CONTROLS],
    ["Arc address", ADDRESS_CONTROLS],
    ["Save address", ADDRESS_CONTROLS],
    ["not yet confirmed", ADDRESS_CONTROLS],
    ["Confirm address", ADDRESS_CONTROLS],
    ["Pays to", APPROVAL_CARD],
    ["This counterparty's address changed after this page loaded. Check the new address and try again.", ADDRESS_LIBRARY],
    ["Approve and pay", APPROVAL_CARD],
    ["Pay now", APPROVAL_CARD],
    ["Reject", APPROVAL_CARD],
    ["Return to agent", APPROVAL_CARD],
    ["You created this invoice", APPROVAL_CARD],
    ["Screened high risk", APPROVAL_CARD],
    ["https://testnet.arcscan.app/tx/", PRIMITIVES],
    ["Audit log", APP_NAV],
    ["Verify hash chain", VERIFY_BADGE],
    ["Chain intact", VERIFY_BADGE],
    ["Every decision is appended here, hash-linked to the one before it and signed with Ed25519.", AUDIT_PAGE],
  ],
};

/**
 * Every Go live error, by code. A `Record` over the code union, so a code
 * added to `GoLiveError` does not compile here until it is listed, and then
 * fails below until the guide's table has its message.
 */
const GO_LIVE_ERRORS: Record<GoLiveErrorCode, true> = {
  invalid: true,
  key_rejected: true,
  unreachable: true,
  different_entity: true,
  not_connected: true,
  entity_secret_rejected: true,
  no_wallets: true,
  already_live: true,
  credentials_unreadable: true,
  credentials_changed: true,
  no_operating_wallet: true,
  hosted_unavailable: true,
  hosted_not_allowed: true,
  hosted_limit_reached: true,
  hosted_has_wallets: true,
};

/** Copy for real users on Arc testnet names the network plainly; it never hedges it away. */
const DISCLAIMERS = [/no real money/i, /fictional/i, /simulated money/i, /no real funds/i, /play money/i, /fake (?:money|usdc|funds)/i];

const sourceFile = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe.each(Object.entries(QUOTED) as Array<[GuideSlug, Array<readonly [string, string]>]>)("the %s guide", (slug, quoted) => {
  const guide = readSource(slug);

  it("quotes some of the app's text", () => {
    expect(quoted.length).toBeGreaterThan(20);
  });

  it.each(quoted)("quotes %j, which %s says", (text, file) => {
    expect(guide, `${slug} should quote ${JSON.stringify(text)}`).toContain(text);
    expect(sourceFile(file), `${file} should contain ${JSON.stringify(text)}`).toContain(text);
  });

  it("names Arc testnet plainly, without disclaimers", () => {
    expect(guide).toMatch(/Arc testnet/);
    for (const disclaimer of DISCLAIMERS) expect(guide).not.toMatch(disclaimer);
  });
});

describe("the Go live guide's failure table", () => {
  const guide = readSource("guides/go-live");

  it.each(Object.keys(GO_LIVE_ERRORS) as GoLiveErrorCode[])("has a row for %s, with its exact message", (code) => {
    const message = new GoLiveError(code).message;
    expect(guide).toMatch(new RegExp(`^\\| ${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`, "m"));
  });
});

describe("the way into the guides", () => {
  it("is linked from the docs Overview and from the API Quickstart", () => {
    expect(readSource("")).toContain('href="/docs/guides/go-live"');
    expect(readSource("get-started/quickstart")).toContain("Using the app rather than the API? Start with [Go live on Arc testnet](/docs/guides/go-live).");
  });
});
