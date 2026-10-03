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

type GuideSlug = "guides/try-it" | "guides/go-live" | "guides/first-payment" | "guides/pay-a-contractor" | "guides/get-paid" | "guides/audit-export";

const PANEL = "src/components/GoLivePanel.tsx";
const GO_LIVE_ACTIONS = "src/app/actions/go-live.ts";
const SAMPLE_PANEL = "src/components/SampleDataPanel.tsx";
const GO_LIVE_LIBRARY = "src/lib/platform/go-live.ts";
const APP_NAV = "src/components/vx/nav.ts";
const PAUSE = "src/components/AgentPauseControl.tsx";
const RUN = "src/components/AgentControlsClient.tsx";
const COUNTERPARTY_FORM = "src/components/intake/CounterpartyIntake.tsx";
const COUNTERPARTIES_PAGE = "src/app/o/[slug]/counterparties/page.tsx";
const INVOICE_FORM = "src/components/intake/InvoiceIntake.tsx";
const INVOICES_PAGE = "src/app/o/[slug]/invoices/page.tsx";
const DOCUMENT_TAB = "src/components/intake/InvoiceDocumentIntake.tsx";
const DOCUMENT_READ = "src/lib/invoice-document/read.ts";
const GATEWAY_PANEL = "src/components/GatewayPanel.tsx";
const ESCROW_PANEL = "src/components/EscrowPanel.tsx";
const MILESTONE_ESCROW = "src/components/MilestoneEscrow.tsx";
const RECEIPT_CONTROL = "src/components/ReceiptControl.tsx";
const RECEIPT_VIEW = "src/components/receipt/ReceiptView.tsx";
const SCREENING_MATCH = "src/components/intake/ScreeningMatch.tsx";
const PAY_LINK_CONTROL = "src/components/PayLinkControl.tsx";
const PAYMENT_CHECK = "src/components/PaymentCheck.tsx";
const PAY_FREELANCER_FORM = "src/components/intake/PayFreelancerForm.tsx";
const PAY_FREELANCER_LIBRARY = "src/lib/pay-freelancer.ts";
const INTAKE_ACTIONS = "src/app/actions/intake.ts";
const ORCHESTRATOR = "src/lib/agent/orchestrator.ts";
const CONSOLE_PAGE = "src/app/o/[slug]/console/page.tsx";
const DECISION_CARD = "src/components/vx/DecisionCard.tsx";
const PRIMITIVES = "src/components/vx/Primitives.tsx";
const APPROVAL_CARD = "src/components/ApprovalCard.tsx";
const APPROVALS_PAGE = "src/app/o/[slug]/approvals/page.tsx";
const VERIFY_BADGE = "src/components/VerifyLedgerBadge.tsx";
const AUDIT_PAGE = "src/app/o/[slug]/audit/page.tsx";
const CHECKLIST = "src/components/vx/GettingStarted.tsx";
const ADDRESS_CONTROLS = "src/components/intake/CounterpartyAddressEdit.tsx";
const ADDRESS_LIBRARY = "src/lib/counterparty-address.ts";
const EXPORT_MENU = "src/components/AuditExportMenu.tsx";
const VERIFIER = "public/tools/verify-ledger-export.mjs";
const LEDGER_KEY_PANEL = "src/components/LedgerKeyPanel.tsx";
const MAP = "src/components/vx/map.ts";
const SCHEDULED_PAYMENTS = "src/components/vx/ScheduledPayments.tsx";
const PAYEE_LINK = "src/components/intake/PayeeLinkControl.tsx";
const CONTRACTORS_PAGE = "src/app/o/[slug]/contractors/page.tsx";
const MILESTONE_FORM = "src/components/intake/MilestoneIntake.tsx";
const MILESTONE_ACTIONS = "src/app/actions/milestones.ts";
const MILESTONE_CHECK = "src/components/MilestoneVerification.tsx";
const GITHUB_CHECK = "src/lib/milestone-verification.ts";
const LOGIN_PAGE = "src/app/login/page.tsx";
const LOGIN_FORM = "src/components/auth/LoginForm.tsx";
const WORKSPACE_FORM = "src/components/CreateWorkspaceForm.tsx";
const OPEN_TABLE = "src/components/open/OpenNumbersTable.tsx";
const APPROVALS_LIST = "src/app/o/[slug]/approvals/page.tsx";
const PAYEE_FORM = "src/components/PayeeAddressForm.tsx";
const PAYEE_STEPS = "src/components/payee/PayeeSteps.tsx";
const PAYEE_JOURNEY = "src/components/payee/PayeeJourney.tsx";
const PAYEE_STATES = "src/lib/payee-journey.ts";
const PAYEE_PAGE = "src/app/payee/[token]/page.tsx";
const PAYEE_ACTIONS = "src/app/payee/[token]/actions.ts";
const PAYEE_EMAIL = "src/lib/email/payee-link.ts";
const HELD_ACTIONS = "src/components/HeldMilestoneActions.tsx";
const MILESTONE_DECISIONS = "src/lib/agent/milestone-decisions.ts";

/** Each guide's quoted UI strings, as `[text, the file it must appear in]`. */
const QUOTED: Record<GuideSlug, Array<readonly [string, string]>> = {
  "guides/try-it": [
    ["Safe to spend today", "src/components/vx/CashOutlook.tsx"],
    ["Next 30 days", "src/components/vx/CashOutlook.tsx"],
    ["Continue with Google", LOGIN_PAGE],
    ["Work email", LOGIN_FORM],
    ["Email me a sign-in link", LOGIN_FORM],
    ["Workspace name", WORKSPACE_FORM],
    ["Create workspace", WORKSPACE_FORM],
    ["Treasury", APP_NAV],
    ["Try it with sample data", SAMPLE_PANEL],
    ["Load sample data", SAMPLE_PANEL],
    ["Run cycle now", RUN],
    ["AP / AR", APP_NAV],
    ["Agent’s reasoning", DECISION_CARD],
    ["Blocked by code, not by the model", DECISION_CARD],
    ["Approvals", APP_NAV],
    ["Approve and pay", APPROVAL_CARD],
    ["Pay now", APPROVAL_CARD],
    ["Nothing is waiting for a decision.", APPROVALS_LIST],
    ["Audit log", APP_NAV],
    ["Verify hash chain", VERIFY_BADGE],
    ["Chain intact", VERIFY_BADGE],
    ["Payments settled on Arc testnet", OPEN_TABLE],
    ["Remove sample data", SAMPLE_PANEL],
    ["Remove the sample data first. It exists only to try the agent with simulated payments.", GO_LIVE_LIBRARY],
    ["Get started", CHECKLIST],
  ],
  "guides/go-live": [
    ["USYC reserve", "src/components/UsycReservePanel.tsx"],
    ["Turn on", "src/components/UsycReservePanel.tsx"],
    ["usyc_reserve_enabled", "src/lib/platform/usyc-reserve.ts"],
    ["Settings", APP_NAV],
    ["Get started", CHECKLIST],
    ["Read the guide", CHECKLIST],
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
    ["Service budget", "src/components/ServiceBudgetPanel.tsx"],
    ["Manage", "src/components/ServiceBudgetPanel.tsx"],
    ["Add to the budget", "src/components/ServiceBudgetPanel.tsx"],
    ["service_budget_funded", "src/lib/circle/gateway-funding.ts"],
    ["service_purchased", "src/lib/agent/services.ts"],
    ["service_purchase_refused", "src/lib/agent/services.ts"],
    ["service_purchase_failed", "src/lib/agent/services.ts"],
    ["addressHistory", "src/lib/agent/orchestrator.ts"],
    ["Suggested by the agent", "src/app/o/[slug]/approvals/page.tsx"],
    ["Accept", "src/components/ProposalCard.tsx"],
    ["Dismiss", "src/components/ProposalCard.tsx"],
    ["policy_proposal_made", "src/lib/agent/proposals.ts"],
    ["policy_proposal_accepted", "src/lib/policy-proposals.ts"],
    ["policy_proposal_dismissed", "src/lib/policy-proposals.ts"],
    ["Recurring", "src/app/o/[slug]/invoices/page.tsx"],
    ["Recurring payments", "src/app/o/[slug]/invoices/page.tsx"],
    ["Pay", "src/components/intake/RecurringPayableIntake.tsx"],
    ["For", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Amount each period", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Every", "src/components/intake/RecurringPayableIntake.tsx"],
    ["First due date", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Last due date", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Contract or PO reference", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Set up recurring payment", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Delivered every period", "src/components/intake/RecurringPayableIntake.tsx"],
    ["Stop", "src/components/intake/RecurringPayableIntake.tsx"],
    ["recurring_payable_created", "src/lib/recurring-payables.ts"],
    ["recurring_payable_stopped", "src/lib/recurring-payables.ts"],
    ["recurring_invoice_created", "src/lib/agent/recurring.ts"],
    ["Agent spending limit", "src/components/AgentBudgetPanel.tsx"],
    ["Set limit", "src/components/AgentBudgetPanel.tsx"],
    ["Per day (USDC)", "src/components/AgentBudgetPanel.tsx"],
    ["Per 7 days (USDC)", "src/components/AgentBudgetPanel.tsx"],
    ["Save limit", "src/components/AgentBudgetPanel.tsx"],
    ["On Arc", "src/components/AgentBudgetPanel.tsx"],
    ["Enforce on Arc", "src/components/AgentBudgetPanel.tsx"],
    ["Finish enforcing on Arc", "src/components/AgentBudgetPanel.tsx"],
    ["Paid through it today", "src/components/AgentBudgetPanel.tsx"],
    ["In the last 7 days", "src/components/AgentBudgetPanel.tsx"],
    ["Turn off on Arc", "src/components/AgentBudgetPanel.tsx"],
    ["workspace.onchain_limit_route", "src/lib/agent/guardrails.ts"],
    ["spending_limit_enforced", "src/lib/circle/spending-limit-setup.ts"],
    ["spending_limit_unenforced", "src/lib/circle/spending-limit-setup.ts"],
    ["agent_budget_changed", "src/lib/agent-budget.ts"],
    ["workspace.outflow_budget", "src/lib/agent/guardrails.ts"],
    ["the agent's spending limit has room for it again", "src/lib/agent/follow-up.ts"],
    ["Screening match", SCREENING_MATCH],
    ["Not this person", SCREENING_MATCH],
    ["Screen again", SCREENING_MATCH],
    ["This match was recorded before Vestiarion kept every possible match.", SCREENING_MATCH],
    ["Dismiss the match", SCREENING_MATCH],
    ["Get paid on Arc", PAY_LINK_CONTROL],
    ["Copy link", PAY_LINK_CONTROL],
    ["I have paid", PAYMENT_CHECK],
    ["Receivables", INVOICES_PAGE],
    ["Counterparties", APP_NAV],
    ["Add counterparty", COUNTERPARTIES_PAGE],
    ["Only an owner or admin of this workspace can add counterparties.", COUNTERPARTIES_PAGE],
    ["Legal or trading name", COUNTERPARTY_FORM],
    ["Payment limit (USDC)", COUNTERPARTY_FORM],
    ["Another chain is paid from Arc through CCTP, for a fee", COUNTERPARTY_FORM],
    ["Payment address", COUNTERPARTY_FORM],
    ["Optional until payment setup", COUNTERPARTY_FORM],
    ["Jurisdiction", COUNTERPARTY_FORM],
    ["Add and screen", COUNTERPARTY_FORM],
    ["added and screened:", INTAKE_ACTIONS],
    ["A payment to a counterparty without one is held for review.", PANEL],
    ["AP / AR", APP_NAV],
    ["New invoice", INVOICES_PAGE],
    ["Needs you", INVOICES_PAGE],
    ["Upcoming", INVOICES_PAGE],
    ["Paid and closed", INVOICES_PAGE],
    ["Enter one invoice", INVOICES_PAGE],
    ["Import CSV", INVOICES_PAGE],
    ["From a document", INVOICES_PAGE],
    ["Or paste the invoice's text", DOCUMENT_TAB],
    ["Read invoice", DOCUMENT_TAB],
    ["The amount the model gave is not in the document, so it was left blank.", DOCUMENT_TAB],
    ["A document cannot say this; tick it only if you received them.", INVOICE_FORM],
    ["This PDF has no text to read; it may be a scan. Paste the invoice's text instead.", DOCUMENT_READ],
    ["Gateway balance", GATEWAY_PANEL],
    ["Amount to move from the operating wallet (USDC)", GATEWAY_PANEL],
    ["Fund Gateway", GATEWAY_PANEL],
    ["Share receipt", RECEIPT_CONTROL],
    ["Receipt shared", RECEIPT_CONTROL],
    ["New link", RECEIPT_CONTROL],
    ["Stop sharing", RECEIPT_CONTROL],
    ["Signed by the paying workspace", RECEIPT_VIEW],
    ["Recorded when it was paid", RECEIPT_VIEW],
    ["Check it yourself", RECEIPT_VIEW],
    ["Direction", INVOICE_FORM],
    ["Payable", INVOICE_FORM],
    ["Amount", INVOICE_FORM],
    ["Currency", INVOICE_FORM],
    ["A EURC payable is paid in EURC, and checked against the payment limit at its USDC value.", INVOICE_FORM],
    ["USDC value", MAP],
    ["no rate", MAP],
    ["Due date", INVOICE_FORM],
    ["Memo", INVOICE_FORM],
    ["PO reference", INVOICE_FORM],
    ["Goods or services received", INVOICE_FORM],
    ["Add invoice", INVOICE_FORM],
    ["Invoice added for", INTAKE_ACTIONS],
    ["The agent usually decides on a payable within a minute of adding it.", INVOICE_FORM],
    ["The agent usually decides on it within a minute.", INTAKE_ACTIONS],
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
    ["Edit limit", "src/components/intake/CounterpartyLimitEdit.tsx"],
    ["Save limit", "src/components/intake/CounterpartyLimitEdit.tsx"],
    ["Configured limit", COUNTERPARTIES_PAGE],
    ["Allowed now", COUNTERPARTIES_PAGE],
    ["Review match", "src/components/CounterpartyRow.tsx"],
    ["Address needed", "src/components/CounterpartyRow.tsx"],
    ["Not screened yet", "src/components/CounterpartyRow.tsx"],
    ["was added, but screening is incomplete", "src/app/actions/intake.ts"],
    ["counterparty.unscreened", "src/lib/agent/guardrails.ts"],
    ["Ready to pay", "src/components/CounterpartyRow.tsx"],
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
    ["Add details", "src/components/AddDetailsDialog.tsx"],
    ["Goods or services received", "src/components/AddDetailsDialog.tsx"],
    ["Since the agent stopped it", "src/lib/added-details.ts"],
    ["The agent decides it again at its next cycle, usually within a minute.", "src/lib/added-details.ts"],
    ["Details added. The agent usually decides it again within a minute.", "src/app/actions/approvals.ts"],
    ["invoice_details_added", "src/lib/agent/approvals.ts"],
    ["invoice_reopened", "src/lib/agent/orchestrator.ts"],
    ["Awaiting information", APPROVAL_CARD],
    ["Needs a purchase order and goods received", "src/lib/added-details.ts"],
    ["Needs a purchase order", "src/lib/added-details.ts"],
    ["Needs goods received", "src/lib/added-details.ts"],
    ["Details added · the agent decides it again", "src/lib/added-details.ts"],
    ["Decide in Approvals", "src/components/WaitingPayableAction.tsx"],
    ["Paid on time with no person involved", "src/components/open/OpenNumbersTable.tsx"],
    ["You created this invoice", APPROVAL_CARD],
    ["You entered this invoice. You are the only person in this workspace who can approve payments, so you can approve it yourself, and the ledger records that you did.", APPROVAL_CARD],
    ["It also records that you entered it yourself, as the workspace's only approver.", APPROVAL_CARD],
    ["(entered and approved by the workspace's only approver)", "src/lib/agent/approvals.ts"],
    ["Screened high risk", APPROVAL_CARD],
    ["The last payment attempt failed:", APPROVAL_CARD],
    ["Approving sends a new transfer.", APPROVAL_CARD],
    [
      "The payment is still in flight on Arc testnet. It cannot be rejected or returned until Circle settles it; approving checks it again.",
      APPROVAL_CARD,
    ],
    ["https://testnet.arcscan.app/tx/", PRIMITIVES],
    ["Audit log", APP_NAV],
    ["Verify hash chain", VERIFY_BADGE],
    ["Chain intact", VERIFY_BADGE],
    ["Every decision is appended here, hash-linked to the one before it and signed with Ed25519.", AUDIT_PAGE],
    ["Try it with sample data", SAMPLE_PANEL],
    ["Load sample data", SAMPLE_PANEL],
    ["Sample data is loaded", SAMPLE_PANEL],
    ["Remove sample data", SAMPLE_PANEL],
    ["Remove the sample data first. It exists only to try the agent with simulated payments.", GO_LIVE_LIBRARY],
    ["Early-payment discount (%)", INVOICE_FORM],
    ["Discount deadline", INVOICE_FORM],
    ["Needed with a discount: the last day it applies, on or before the due date.", INVOICE_FORM],
    ["Enter the last day the discount applies, on or before the due date, or clear the discount.", "src/lib/intake-validation.ts"],
    ["The discount deadline was left blank: the invoice does not give one that could be read. Enter the last day the discount applies, or clear the discount.", "src/lib/invoice-document/normalize.ts"],
    ["Scheduled for", MAP],
    ["% off if paid by", MAP],
    ["Not yet decided", MAP],
    ["Payment in flight", MAP],
    ["Scheduled payments", SCHEDULED_PAYMENTS],
  ],
  "guides/get-paid": [
    ["Your address", PAYEE_STEPS],
    ["Confirmation", PAYEE_STEPS],
    ["Payment", PAYEE_STEPS],
    ["Add my address", PAYEE_EMAIL],
    ["Vestiarion only needs your address. It never asks for your recovery phrase or private key.", PAYEE_JOURNEY],
    ["Continue", PAYEE_FORM],
    ["That doesn't look like a wallet address. It starts with 0x and has 42 characters in all.", PAYEE_STATES],
    ["Check your address", PAYEE_FORM],
    ["Before you send it, tick all three", PAYEE_FORM],
    ["Tick all three boxes to send your address.", PAYEE_FORM],
    ["It's my own wallet, and I can open it.", PAYEE_FORM],
    ["It's not an exchange deposit address.", PAYEE_FORM],
    ["The first and last characters match my wallet.", PAYEE_FORM],
    ["Send my address", PAYEE_FORM],
    ["Edit address", PAYEE_FORM],
    ["Address sent", PAYEE_JOURNEY],
    ["Your address is confirmed", PAYEE_JOURNEY],
    ["View on Arcscan", PAYEE_JOURNEY],
    ["to approve the work", PAYEE_STATES],
    ["Being prepared", PAYEE_STATES],
    ["Scheduled for", PAYEE_STATES],
    ["for review", PAYEE_STATES],
    ["On its way", PAYEE_STATES],
    ["Paid", PAYEE_STATES],
    ["This link is no longer valid. Ask the business that sent it for a new one.", PAYEE_PAGE],
    ["This page could not load. Try again in a moment.", PAYEE_PAGE],
    ["That did not work. Try again in a moment.", PAYEE_ACTIONS],
    ["That is already the address", PAYEE_ACTIONS],
  ],
  "guides/pay-a-contractor": [
    ["Pay a freelancer", "src/app/o/[slug]/contractors/page.tsx"],
    ["paid in one Arc transaction with", "src/lib/agent/orchestrator.ts"],
    ["executeBatch", "src/lib/circle/batch.ts"],
    ["Freelancer's name", PAY_FREELANCER_FORM],
    ["Freelancer's email", PAY_FREELANCER_FORM],
    ["What they delivered", PAY_FREELANCER_FORM],
    ["Link to the work", PAY_FREELANCER_FORM],
    ["Set up payment", PAY_FREELANCER_FORM],
    ["Copy link", PAY_FREELANCER_FORM],
    ["Delivered work confirmed when the payment was set up", PAY_FREELANCER_LIBRARY],
    ["Set up escrow", ESCROW_PANEL],
    ["Milestone escrow", ESCROW_PANEL],
    ["Finish setting up", ESCROW_PANEL],
    ["Refundable to this workspace from", MILESTONE_ESCROW],
    ["Lock in escrow", MILESTONE_ESCROW],
    ["Refund from escrow", MILESTONE_ESCROW],
    ["Counterparties", APP_NAV],
    ["Role", COUNTERPARTY_FORM],
    ["Contractor", COUNTERPARTY_FORM],
    ["Payment limit (USDC)", COUNTERPARTY_FORM],
    ["Ask for address", PAYEE_LINK],
    ["Create link", PAYEE_LINK],
    ["Confirm address", ADDRESS_CONTROLS],
    ["Contractors", APP_NAV],
    ["Milestone intake", CONTRACTORS_PAGE],
    ["New payment", CONTRACTORS_PAGE],
    ["In progress", CONTRACTORS_PAGE],
    ["Contractor", MILESTONE_FORM],
    ["Amount (USDC)", MILESTONE_FORM],
    ["Work delivered", MILESTONE_FORM],
    ["Evidence link", MILESTONE_FORM],
    ["Add milestone", MILESTONE_FORM],
    ["The agent is waiting for milestone verification.", MAP],
    ["create_milestone", MILESTONE_ACTIONS],
    ["The agent checks the pull request within a minute, and decides on pay once it is merged.", MILESTONE_ACTIONS],
    ["Verified by", MAP],
    ["merged PR", MAP],
    ["verify_milestone_github", GITHUB_CHECK],
    ["Verify it once the work is delivered, and the agent decides on pay within a minute.", MILESTONE_ACTIONS],
    ["Evidence", MAP],
    ["Evidence checked or approver note", MILESTONE_CHECK],
    ["Verify manually", MILESTONE_CHECK],
    ["verify_milestone_manual", MILESTONE_ACTIONS],
    ["Revoke manually", MILESTONE_CHECK],
    ["Paid and closed", CONTRACTORS_PAGE],
    ["Address to confirm", CONTRACTORS_PAGE],
    ["Waiting for an address", CONTRACTORS_PAGE],
    ["What it waits for", HELD_ACTIONS],
    ["Pay now", HELD_ACTIONS],
    ["Close without paying", HELD_ACTIONS],
    ["You added this milestone, so someone else must approve paying it.", HELD_ACTIONS],
    ["You added this milestone. You are the only person in this workspace who can approve payments, so you can pay it yourself, and the ledger records that you did.", HELD_ACTIONS],
    ["Circle did not send it", MILESTONE_DECISIONS],
    ["Limit lowered by a screening match", MILESTONE_DECISIONS],
    ["milestone_approval_paid", MILESTONE_DECISIONS],
    ["milestone_closed", MILESTONE_DECISIONS],
    ["Closed without paying", MAP],
    ["Audit log", APP_NAV],
  ],
  "guides/audit-export": [
    ["Audit log", APP_NAV],
    ["Download", EXPORT_MENU],
    ["Signed JSON", EXPORT_MENU],
    ["CSV", EXPORT_MENU],
    ["Compare this key id and the head hash with the ones a verified export prints.", AUDIT_PAGE],
    ["VALID", VERIFIER],
    ["BROKEN", VERIFIER],
    ["NOT CHECKED", VERIFIER],
    ["vestiarion-ledger-export/1", VERIFIER],
    ["Settings", APP_NAV],
    ["Ledger signing key", LEDGER_KEY_PANEL],
    ["Rotate signing key", LEDGER_KEY_PANEL],
    ["Retired keys", LEDGER_KEY_PANEL],
    ["An owner of this workspace can rotate the key.", LEDGER_KEY_PANEL],
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
  sample_data_loaded: true,
};

/** Copy for real users on Arc testnet names the network plainly; it never hedges it away. */
const DISCLAIMERS = [/no real money/i, /fictional/i, /simulated money/i, /no real funds/i, /play money/i, /fake (?:money|usdc|funds)/i];

const sourceFile = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/**
 * How many of the app's own strings a guide must quote. The two user-journey
 * guides walk a whole workflow across many screens; the export guide is
 * narrower — mostly the export format and the verifier's own output — so its
 * bar is lower, but still enough to show it is grounded in the real UI.
 */
const MIN_QUOTED: Record<GuideSlug, number> = {
  "guides/try-it": 20,
  "guides/go-live": 20,
  "guides/first-payment": 20,
  "guides/pay-a-contractor": 20,
  "guides/get-paid": 20,
  "guides/audit-export": 5,
};

describe.each(Object.entries(QUOTED) as Array<[GuideSlug, Array<readonly [string, string]>]>)("the %s guide", (slug, quoted) => {
  const guide = readSource(slug);

  it("quotes some of the app's text", () => {
    expect(quoted.length).toBeGreaterThan(MIN_QUOTED[slug]);
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

describe("the first-payment guide's steps", () => {
  const guide = readSource("guides/first-payment");
  const sections = [...guide.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

  it("numbers every section after the sample-data tour, in order", () => {
    const steps = sections.slice(sections.findIndex((title) => /^1\. /.test(title)));
    expect(steps.length).toBeGreaterThan(1);
    steps.forEach((title, index) => expect(title, title).toMatch(new RegExp(`^${index + 1}\\. `)));
  });

  it("counts scheduling among what a cycle does, and among a card's outcomes", () => {
    expect(guide).toContain("pays, schedules, holds or flags each one");
    expect(guide).toContain('the outcome: "Settled on Arc", "Scheduled for *date*", "Held for you" or "Refused by guardrail";');
  });

  it("says the sample data's annual support plan is scheduled for its discount deadline", () => {
    const tour = guide.split("## Try it with sample data first")[1]?.split("\n## ")[0] ?? "";
    expect(tour).toMatch(/^- an annual support plan .*scheduled for its discount deadline/m);
  });
});

describe("the Try it guide's sample outcomes", () => {
  const bullets = (text: string) => [...text.matchAll(/^- (.+)$/gm)].map((match) => match[1]);

  it("lists the same outcomes as the first-payment guide's sample-data tour", () => {
    const tour = readSource("guides/first-payment").split("## Try it with sample data first")[1]?.split("\n## ")[0] ?? "";
    const step = readSource("guides/try-it").split("## 3. Load sample data")[1]?.split("\n## ")[0] ?? "";
    expect(bullets(tour).length).toBeGreaterThan(4);
    expect(bullets(step)).toEqual(bullets(tour));
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
    expect(readSource("")).toContain('href="/docs/guides/try-it"');
    expect(readSource("get-started/quickstart")).toContain("Using the app rather than the API? Start with [Go live on Arc testnet](/docs/guides/go-live).");
  });
});
