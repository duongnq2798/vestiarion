import type { ActivityItem } from "../agent-activity";
import { readAgentActivity } from "../agent-activity-read";
import { siteOrigin } from "../auth/env";
import { addressHash, approveRefusal } from "../commands/chat-decisions";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import type { NoticeLine } from "../payment-notices";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { shortenAddresses } from "../telegram/messages";
import { postToWebhook } from "./api";
import { decisionsMessage, type CardView } from "./blocks";
import { installFor, moveCursor, webhookUrlOf, type SlackInstall } from "./installs";
import { slackSettingsFromEnv, type SlackSettings } from "./settings";
import { cardToken } from "./state";

/**
 * The cycle's `slack` stage (Slack design S7, S8): the install's channel is told the agent's decisions after its
 * cursor, read the way the console's activity toasts and the Telegram stage read them, and the cursor then moves past
 * everything read, but only once Slack took the message; a failed post is posted again by the next cycle. While
 * deciding from Slack is on, each stopped payable that is still waiting gets its card. Runs inside the workspace's
 * scope; quietly does nothing when Slack is not configured or the workspace has no install.
 */

export interface SlackNotifyDeps {
  settings?: SlackSettings | null;
  fetchImpl?: typeof fetch;
  origin?: string;
  keys?: MasterKey[];
  now?: () => number;
}

const WAITING = ["held", "flagged", "awaiting_info"];
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

interface CardRow {
  id: string;
  amount: string | number;
  currency: string | null;
  status: string;
  direction: string;
  decided_at: string | null;
  early_pay_discount_pct: string | number | null;
  counterparties: { name: string; address: string | null; chain: string | null; address_changed_at: string | null; address_confirmed_at: string | null } | null;
}

/** Each stopped payable's card, read in one query: still waiting payables only, Approve only where it qualifies (S8, S9). */
async function cardViews(items: ActivityItem[], install: SlackInstall, keys: MasterKey[], now: number): Promise<Map<string, CardView>> {
  const ids = [...new Set(items.filter((item) => item.tone === "stopped" && item.invoiceId).map((item) => item.invoiceId as string))];
  const views = new Map<string, CardView>();
  if (ids.length === 0) return views;
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, currency, status, direction, decided_at, early_pay_discount_pct, counterparties(name, address, chain, address_changed_at, address_confirmed_at)")
      .in("id", ids)
  ) as unknown as CardRow[];
  for (const row of rows) {
    if (row.direction !== "payable" || !WAITING.includes(row.status)) continue;
    const payee = row.counterparties;
    const address = payee?.address ?? null;
    const currency = row.currency ?? "USDC";
    const refusal = approveRefusal(
      {
        amount: row.amount,
        currency,
        chain: payee?.chain ?? null,
        address,
        addressChangedAt: payee?.address_changed_at ?? null,
        addressConfirmedAt: payee?.address_confirmed_at ?? null,
      },
      install.decisionsLimitUsdc,
      "Slack"
    );
    const discount = row.early_pay_discount_pct !== null ? " Its early-payment discount comes off, if still due." : "";
    views.set(row.id, {
      invoiceId: row.id,
      token: cardToken({ org: install.orgId, invoice: row.id, decidedAt: row.decided_at, addressHash: addressHash(address) }, keys, now),
      approveRefusal: refusal ? refusal.message : null,
      confirmText: `Pays ${AMOUNT.format(Number(row.amount))} ${currency} to ${payee?.name ?? "the payee"} on Arc testnet, to ${address ? shortenAddresses(address) : "no address"}.${discount}`,
    });
  }
  return views;
}

export async function sendSlackDecisions(deps: SlackNotifyDeps = {}): Promise<NoticeLine[]> {
  const settings = deps.settings === undefined ? slackSettingsFromEnv() : deps.settings;
  if (!settings) return [];
  const orgId = currentOrgId();
  const install = await installFor(orgId);
  if (!install) return [];

  const read = await readAgentActivity(install.notifiedSeq);
  if (read.items.length === 0) {
    if (read.through > install.notifiedSeq) await moveCursor(install.id, read.through);
    return [];
  }
  const keys = deps.keys ?? masterKeysFromEnv();
  const now = deps.now?.() ?? Date.now();
  const workspace = unwrap(await platformDb().from("orgs").select("slug, name").eq("id", orgId).single<{ slug: string; name: string }>());
  const cards = install.decisionsLimitUsdc === null ? null : await cardViews(read.items, install, keys, now);
  const message = decisionsMessage(workspace, read.items, deps.origin ?? siteOrigin(), cards);

  const posted = await postToWebhook(webhookUrlOf(install, keys), message, deps.fetchImpl);
  if (!posted.ok) {
    // The status and Slack's code, never the webhook's URL: it is a credential.
    console.error("slack: decisions not posted, kept for the next cycle", orgId, posted.status, posted.error);
    return [];
  }
  await moveCursor(install.id, read.through);
  return [{ domain: "system", message: "Told the workspace's Slack channel what the agent decided" }];
}
