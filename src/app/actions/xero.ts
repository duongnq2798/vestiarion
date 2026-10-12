"use server";

import "server-only";

import { accountingProvider } from "@/lib/accounting-providers";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { addAccountingBills, consoleActor, dismissAccountingBills } from "@/lib/commands";
import { choosePaymentAccount, connectionFor, disconnectConnection, NotSetUpError, type Connection } from "@/lib/connectors/connections";
import type { AccountingProvider, ExternalAccount } from "@/lib/connectors/provider";
import { syncInScope } from "@/lib/connectors/sweep";
import { connectionTokenStore } from "@/lib/connectors/token-store";
import { freshAccessToken } from "@/lib/connectors/tokens";
import { inOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";

/**
 * Xero from the console (docs/superpowers/specs/2026-10-12-xero-connector-design.md X3, X7, X11, X13, X14): syncing
 * now, disconnecting and choosing the account payments will be booked to are an owner's or admin's
 * (`integrations.manage`); adding and dismissing the bills it brought in are for whoever adds records
 * (`records.write`). Every action reads the person's role again and works in the workspace's scope; nothing returned
 * carries a token.
 */

export interface XeroActionResult {
  ok: boolean;
  message: string;
}

export interface XeroAccountsResult extends XeroActionResult {
  accounts?: ExternalAccount[];
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "Xero is not set up on this deployment yet.";
const NOT_CONNECTED = "Xero is not connected to this workspace.";
const RECONNECT = "Xero needs you to reconnect. Reconnect Xero from this card, then try again.";

/** The workspace's Xero connection and the provider, or why there is none. */
async function connected(): Promise<{ connection: Connection; provider: AccountingProvider } | { message: string }> {
  const provider = accountingProvider("xero");
  if (!provider) return { message: NOT_SET_UP };
  try {
    const connection = await connectionFor("xero");
    if (!connection || connection.status === "revoked") return { message: NOT_CONNECTED };
    return { connection, provider };
  } catch (error) {
    if (error instanceof NotSetUpError) return { message: NOT_SET_UP };
    throw error;
  }
}

const SYNC_WORDS: Record<string, string> = {
  partial: "Synced part of it. The rest follows within 15 minutes.",
  busy: "A sync is running already. Look again in a minute.",
  reconnect: RECONNECT,
};

/** Sync now: one run, with a smaller page budget than the sweeper's. */
export async function syncXeroNowAction(_previous: XeroActionResult, formData: FormData): Promise<XeroActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      if (found.connection.status !== "connected") return { ok: false, message: RECONNECT };
      const result = await syncInScope(found.connection.id, found.provider, { maxPages: 5 });
      revalidateOrgPages();
      if (result.outcome === "synced") {
        return { ok: true, message: result.newBills === 0 ? "Synced. No new bills." : `Synced. ${result.newBills} new ${result.newBills === 1 ? "bill" : "bills"} to review on Bills & receivables.` };
      }
      if (result.outcome in SYNC_WORDS) return { ok: result.outcome === "partial", message: SYNC_WORDS[result.outcome] };
      // The card says why, and when the next try is.
      return { ok: false, message: "The sync stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncXeroNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

export async function disconnectXeroAction(_previous: XeroActionResult, formData: FormData): Promise<XeroActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      await disconnectConnection({ connection: found.connection, by: auth.user.id, revoke: found.provider.revoke });
      revalidateOrgPages();
      return { ok: true, message: "Xero is disconnected. Bills already added stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectXeroAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** The accounts of the chart a payment can be booked to, read from Xero now (I14). */
async function payableAccounts(found: { connection: Connection; provider: AccountingProvider }): Promise<ExternalAccount[] | { message: string }> {
  const token = await freshAccessToken({ store: connectionTokenStore(found.connection.orgId, found.connection.id), refresh: found.provider.refresh });
  if (!token.ok) return { message: token.reason === "reconnect" || token.reason === "missing" ? RECONNECT : "Xero did not answer. Try again in a moment." };
  return found.provider.accounts({ accessToken: token.accessToken, externalOrgId: found.connection.externalOrgId });
}

export async function loadXeroAccountsAction(_previous: XeroAccountsResult, formData: FormData): Promise<XeroAccountsResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      const accounts = await payableAccounts(found);
      if ("message" in accounts) return { ok: false, message: accounts.message };
      if (accounts.length === 0) return { ok: false, message: "Xero has no active bank account to book payments to. Add one in Xero, then try again." };
      return { ok: true, message: "", accounts };
    } catch (error) {
      console.error("loadXeroAccountsAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "Xero's chart of accounts could not be read. Try again in a moment." };
    }
  });
}

export async function chooseXeroAccountAction(_previous: XeroActionResult, formData: FormData): Promise<XeroActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const accountId = formData.get("accountId");
    if (typeof accountId !== "string" || accountId === "") return { ok: false, message: "Choose an account." };
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      // Read again from Xero: the account must still be there, active and able to take a payment.
      const accounts = await payableAccounts(found);
      if ("message" in accounts) return { ok: false, message: accounts.message };
      const account = accounts.find((candidate) => candidate.externalId === accountId);
      if (!account) return { ok: false, message: "That account is no longer one Xero lets a payment be booked to. Choose another." };
      await choosePaymentAccount({
        connection: found.connection,
        account: { id: account.externalId, code: account.code, name: account.name, currency: account.currency },
        by: auth.user.id,
      });
      revalidateOrgPages();
      return { ok: true, message: `Payments made on Arc will be booked to ${account.name} in Xero.` };
    } catch (error) {
      console.error("chooseXeroAccountAction failed", error instanceof Error ? error.message : "unknown error");
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

export async function addXeroBillsAction(_previous: XeroActionResult, formData: FormData): Promise<XeroActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const connectionId = formData.get("connectionId");
    const outcome = await addAccountingBills(consoleActor(auth), {
      connectionId: typeof connectionId === "string" ? connectionId : "",
      billIds: billIds(formData),
      goodsReceived: formData.get("goodsReceived") === "true",
    });
    return consoleAnswer(outcome);
  });
}

export async function dismissXeroBillsAction(_previous: XeroActionResult, formData: FormData): Promise<XeroActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const connectionId = formData.get("connectionId");
    const outcome = await dismissAccountingBills(consoleActor(auth), { connectionId: typeof connectionId === "string" ? connectionId : "", billIds: billIds(formData) });
    return consoleAnswer(outcome);
  });
}
