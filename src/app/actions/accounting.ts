"use server";

import "server-only";

import { accountingProvider } from "@/lib/accounting-providers";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { addAccountingBills, consoleActor, dismissAccountingBills } from "@/lib/commands";
import { choosePaymentAccount, connectionFor, disconnectConnection, NotSetUpError, type Connection } from "@/lib/connectors/connections";
import { PROVIDER_LABELS, PROVIDER_WORDS, PROVIDERS, type AccountingProvider, type ExternalAccount, type ProviderId } from "@/lib/connectors/provider";
import { syncInScope } from "@/lib/connectors/sweep";
import { connectionTokenStore } from "@/lib/connectors/token-store";
import { freshAccessToken } from "@/lib/connectors/tokens";
import { inOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";

/**
 * An accounting tool from the console, whichever it is (docs/superpowers/specs/2026-10-12-xero-connector-design.md X3,
 * X7, X11, X13, X14; docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q1, Q14): syncing now,
 * disconnecting and choosing the account payments will be booked to are an owner's or admin's
 * (`integrations.manage`); adding and dismissing the bills it brought in are for whoever adds records
 * (`records.write`). Each form names its tool; every action reads the person's role again and works in the
 * workspace's scope; nothing returned carries a token.
 */

export interface AccountingActionResult {
  ok: boolean;
  message: string;
}

export interface AccountingAccountsResult extends AccountingActionResult {
  accounts?: ExternalAccount[];
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const reconnectWords = (label: string) => `${label} needs you to reconnect. Reconnect ${label} from this card, then try again.`;

/** The tool a form names, or null for one this deployment does not know. */
function providerOf(formData: FormData): ProviderId | null {
  const value = formData.get("provider");
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value) ? (value as ProviderId) : null;
}

/** The workspace's connection to the tool and the provider, or why there is none. */
async function connected(id: ProviderId): Promise<{ connection: Connection; provider: AccountingProvider } | { message: string }> {
  const label = PROVIDER_LABELS[id];
  const notSetUp = `${label} is not set up on this deployment yet.`;
  const provider = accountingProvider(id);
  if (!provider) return { message: notSetUp };
  try {
    const connection = await connectionFor(id);
    if (!connection || connection.status === "revoked") return { message: `${label} is not connected to this workspace.` };
    return { connection, provider };
  } catch (error) {
    if (error instanceof NotSetUpError) return { message: notSetUp };
    throw error;
  }
}

/** Sync now: one run, with a smaller page budget than the sweeper's. */
export async function syncAccountingNowAction(_previous: AccountingActionResult, formData: FormData): Promise<AccountingActionResult> {
  const id = providerOf(formData);
  if (!id) return { ok: false, message: TRY_AGAIN };
  const label = PROVIDER_LABELS[id];
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected(id);
      if ("message" in found) return { ok: false, message: found.message };
      if (found.connection.status !== "connected") return { ok: false, message: reconnectWords(label) };
      const result = await syncInScope(found.connection.id, found.provider, { maxPages: 5 });
      revalidateOrgPages();
      if (result.outcome === "synced") {
        return { ok: true, message: result.newBills === 0 ? "Synced. No new bills." : `Synced. ${result.newBills} new ${result.newBills === 1 ? "bill" : "bills"} to review on Bills & receivables.` };
      }
      if (result.outcome === "partial") return { ok: true, message: "Synced part of it. The rest follows within 15 minutes." };
      if (result.outcome === "busy") return { ok: false, message: "A sync is running already. Look again in a minute." };
      if (result.outcome === "reconnect") return { ok: false, message: reconnectWords(label) };
      // The card says why, and when the next try is.
      return { ok: false, message: "The sync stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncAccountingNowAction failed", id, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

export async function disconnectAccountingAction(_previous: AccountingActionResult, formData: FormData): Promise<AccountingActionResult> {
  const id = providerOf(formData);
  if (!id) return { ok: false, message: TRY_AGAIN };
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected(id);
      if ("message" in found) return { ok: false, message: found.message };
      await disconnectConnection({ connection: found.connection, by: auth.user.id, revoke: found.provider.revoke });
      revalidateOrgPages();
      return { ok: true, message: `${PROVIDER_LABELS[id]} is disconnected. Bills already added stay in Vestiarion.` };
    } catch (error) {
      console.error("disconnectAccountingAction failed", id, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** The accounts a payment can be booked to, read from the tool now (I14). */
async function payableAccounts(id: ProviderId, found: { connection: Connection; provider: AccountingProvider }): Promise<ExternalAccount[] | { message: string }> {
  const label = PROVIDER_LABELS[id];
  const token = await freshAccessToken({ store: connectionTokenStore(found.connection.orgId, found.connection.id), refresh: found.provider.refresh });
  if (!token.ok) return { message: token.reason === "reconnect" || token.reason === "missing" ? reconnectWords(label) : `${label} did not answer. Try again in a moment.` };
  return found.provider.accounts({ accessToken: token.accessToken, externalOrgId: found.connection.externalOrgId });
}

export async function loadAccountingAccountsAction(_previous: AccountingAccountsResult, formData: FormData): Promise<AccountingAccountsResult> {
  const id = providerOf(formData);
  if (!id) return { ok: false, message: TRY_AGAIN };
  const label = PROVIDER_LABELS[id];
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected(id);
      if ("message" in found) return { ok: false, message: found.message };
      const accounts = await payableAccounts(id, found);
      if ("message" in accounts) return { ok: false, message: accounts.message };
      if (accounts.length === 0) return { ok: false, message: `${label} has no active bank account to book payments to. Add one in ${label}, then try again.` };
      return { ok: true, message: "", accounts };
    } catch (error) {
      console.error("loadAccountingAccountsAction failed", id, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: `${PROVIDER_WORDS[id].possessive} ${PROVIDER_WORDS[id].accounts} could not be read. Try again in a moment.` };
    }
  });
}

export async function chooseAccountingAccountAction(_previous: AccountingActionResult, formData: FormData): Promise<AccountingActionResult> {
  const id = providerOf(formData);
  if (!id) return { ok: false, message: TRY_AGAIN };
  const label = PROVIDER_LABELS[id];
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const accountId = formData.get("accountId");
    if (typeof accountId !== "string" || accountId === "") return { ok: false, message: "Choose an account." };
    try {
      const found = await connected(id);
      if ("message" in found) return { ok: false, message: found.message };
      // Read again from the tool: the account must still be there, active and able to take a payment.
      const accounts = await payableAccounts(id, found);
      if ("message" in accounts) return { ok: false, message: accounts.message };
      const account = accounts.find((candidate) => candidate.externalId === accountId);
      if (!account) return { ok: false, message: `That account is no longer one ${label} lets a payment be booked to. Choose another.` };
      await choosePaymentAccount({
        connection: found.connection,
        account: { id: account.externalId, code: account.code, name: account.name, currency: account.currency },
        by: auth.user.id,
      });
      revalidateOrgPages();
      return { ok: true, message: `Payments made on Arc will be booked to ${account.name} in ${label}.` };
    } catch (error) {
      console.error("chooseAccountingAccountAction failed", id, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** The bills ticked in the review list, from the form: never more than the list shows. */
function billIds(formData: FormData): string[] {
  return formData
    .getAll("billId")
    .filter((value): value is string => typeof value === "string")
    .slice(0, 200);
}

/** The connection a form names, checked again by the command against the workspace in scope. */
const connectionIdOf = (formData: FormData) => {
  const value = formData.get("connectionId");
  return typeof value === "string" ? value : "";
};

export async function addAccountingBillsAction(_previous: AccountingActionResult, formData: FormData): Promise<AccountingActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const outcome = await addAccountingBills(consoleActor(auth), {
      connectionId: connectionIdOf(formData),
      billIds: billIds(formData),
      goodsReceived: formData.get("goodsReceived") === "true",
    });
    return consoleAnswer(outcome);
  });
}

export async function dismissAccountingBillsAction(_previous: AccountingActionResult, formData: FormData): Promise<AccountingActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const outcome = await dismissAccountingBills(consoleActor(auth), { connectionId: connectionIdOf(formData), billIds: billIds(formData) });
    return consoleAnswer(outcome);
  });
}
