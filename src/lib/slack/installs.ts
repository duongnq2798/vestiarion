import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";
import type { InstallGrant } from "./api";

/**
 * A workspace's Slack install (Slack design S3, S7, S8, S13), in platform rows the service role alone reads and writes
 * (migration 0067). The bot token and the webhook's URL are kept only as envelopes under the master key, bound to the
 * workspace and their column. Whatever changes an install is recorded in the workspace's own ledger, with ids only;
 * those functions run inside that workspace's scope.
 */

export interface SlackInstall {
  id: string;
  orgId: string;
  teamId: string;
  teamName: string | null;
  appId: string;
  channelId: string;
  channelName: string | null;
  installedBy: string | null;
  installedAt: string;
  /** The last ledger entry the channel was told about. */
  notifiedSeq: number;
  /** Null: deciding payments from Slack is off (S8). */
  decisionsLimitUsdc: number | null;
  botTokenEnc: SecretEnvelope;
  webhookUrlEnc: SecretEnvelope;
}

interface InstallRow {
  id: string;
  org_id: string;
  team_id: string;
  team_name: string | null;
  app_id: string;
  channel_id: string;
  channel_name: string | null;
  installed_by: string | null;
  installed_at: string;
  notified_seq: number | string;
  decisions_limit_usdc: number | string | null;
  bot_token_enc: SecretEnvelope;
  webhook_url_enc: SecretEnvelope;
}

const COLUMNS =
  "id, org_id, team_id, team_name, app_id, channel_id, channel_name, installed_by, installed_at, notified_seq, decisions_limit_usdc, bot_token_enc, webhook_url_enc";
const TOKEN_COLUMN = "slack_installs.bot_token_enc";
const WEBHOOK_COLUMN = "slack_installs.webhook_url_enc";

const toInstall = (row: InstallRow): SlackInstall => ({
  id: row.id,
  orgId: row.org_id,
  teamId: row.team_id,
  teamName: row.team_name,
  appId: row.app_id,
  channelId: row.channel_id,
  channelName: row.channel_name,
  installedBy: row.installed_by,
  installedAt: row.installed_at,
  notifiedSeq: Number(row.notified_seq),
  decisionsLimitUsdc: row.decisions_limit_usdc === null ? null : Number(row.decisions_limit_usdc),
  botTokenEnc: row.bot_token_enc,
  webhookUrlEnc: row.webhook_url_enc,
});

async function oneInstall(column: "org_id" | "team_id", value: string): Promise<SlackInstall | null> {
  const rows = unwrap(await platformDb().from("slack_installs").select(COLUMNS).eq(column, value).limit(1)) as InstallRow[];
  return rows[0] ? toInstall(rows[0]) : null;
}

export function installFor(orgId: string): Promise<SlackInstall | null> {
  return oneInstall("org_id", orgId);
}

export function installOfTeam(teamId: string): Promise<SlackInstall | null> {
  return oneInstall("team_id", teamId);
}

export function webhookUrlOf(install: SlackInstall, keys: MasterKey[] = masterKeysFromEnv()): string {
  return decryptSecret(install.webhookUrlEnc, { orgId: install.orgId, column: WEBHOOK_COLUMN }, keys);
}

export function botTokenOf(install: SlackInstall, keys: MasterKey[] = masterKeysFromEnv()): string {
  return decryptSecret(install.botTokenEnc, { orgId: install.orgId, column: TOKEN_COLUMN }, keys);
}

/** Entries about an install belong to its own workspace's ledger, and nowhere else. */
function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("A Slack install's entry cannot be written to another workspace's ledger");
}

async function ledgerHead(): Promise<number> {
  const rows = unwrap(await db().from("ledger_entries").select("seq").order("seq", { ascending: false }).limit(1)) as Array<{ seq: number | string }>;
  return Number(rows[0]?.seq ?? 0);
}

export type SaveResult = { ok: true; install: SlackInstall } | { ok: false; reason: "team_taken" };

/**
 * Saves what an install granted (S3). A Slack team serving another workspace is refused, and nothing is written. The
 * workspace's install of another team is replaced, and its links go with it; an install of the same team is updated,
 * keeping its links and its limit. Either way the cursor starts at the ledger's head, so the channel is never sent the
 * past, and the person who installed is linked to the Slack account Slack authenticated.
 */
export async function saveInstall(
  input: { orgId: string; installedBy: string; grant: InstallGrant },
  keys: MasterKey[] = masterKeysFromEnv()
): Promise<SaveResult> {
  const { orgId, installedBy, grant } = input;
  requireScope(orgId);
  const serving = await installOfTeam(grant.teamId);
  if (serving && serving.orgId !== orgId) return { ok: false, reason: "team_taken" };

  const current = await installFor(orgId);
  if (current && current.teamId !== grant.teamId) {
    unwrap(await platformDb().from("slack_installs").delete().eq("id", current.id).select("id"));
  }

  const row = {
    org_id: orgId,
    team_id: grant.teamId,
    team_name: grant.teamName,
    app_id: grant.appId,
    bot_user_id: grant.botUserId,
    channel_id: grant.channelId,
    channel_name: grant.channelName,
    installed_by: installedBy,
    installed_at: new Date().toISOString(),
    notified_seq: await ledgerHead(),
    bot_token_enc: encryptSecret(grant.botToken, { orgId, column: TOKEN_COLUMN }, keys),
    webhook_url_enc: encryptSecret(grant.webhookUrl, { orgId, column: WEBHOOK_COLUMN }, keys),
  };
  const [saved] = unwrap(await platformDb().from("slack_installs").upsert(row, { onConflict: "org_id" }).select(COLUMNS)) as InstallRow[];
  const install = toInstall(saved);

  unwrap(
    await platformDb()
      .from("slack_links")
      .delete()
      .or(`and(org_id.eq.${orgId},user_id.eq.${installedBy}),and(team_id.eq.${grant.teamId},slack_user_id.eq.${grant.installerSlackUserId})`)
      .select("id")
  );
  const [link] = unwrap(
    await platformDb()
      .from("slack_links")
      .insert({ org_id: orgId, user_id: installedBy, team_id: grant.teamId, slack_user_id: grant.installerSlackUserId })
      .select("id")
  ) as Array<{ id: string }>;

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "slack_installed",
    summary: "Connected a Slack workspace: the agent's decisions now go to one of its channels",
    detail: { by: installedBy, teamId: grant.teamId, channelId: grant.channelId },
  });
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "slack_member_connected",
    summary: "Connected a member's own Slack account",
    detail: { by: installedBy, linkId: link?.id ?? null, via: "install" },
  });
  return { ok: true, install };
}

/**
 * Sets the most a payment approved from Slack may be, or turns deciding there off with null (S8): an owner's decision.
 */
export async function setDecisionsLimit(install: SlackInstall, limit: number | null, by: string): Promise<void> {
  requireScope(install.orgId);
  unwrap(await platformDb().from("slack_installs").update({ decisions_limit_usdc: limit }).eq("id", install.id).select("id"));
  await appendLedgerEntryBestEffort(install.orgId, {
    actor: "human",
    domain: "system",
    action: "slack_decisions_limit_changed",
    summary: limit === null ? "Turned off deciding payments from Slack" : `Allowed deciding payments from Slack, up to ${limit} USDC`,
    detail: { by, from: install.decisionsLimitUsdc, to: limit },
  });
}

/** Moves the channel's cursor to `seq`, never back (S7). */
export async function moveCursor(installId: string, seq: number): Promise<void> {
  const result = await platformDb().from("slack_installs").update({ notified_seq: seq }).eq("id", installId).lt("notified_seq", seq);
  if (result.error) throw new Error(result.error.message);
}

/**
 * Removes an install and, with it, every link to it (S13): from Settings, or because Slack said the app was
 * uninstalled. Records it when a row went; answers whether one did.
 */
export async function removeInstall(install: SlackInstall, via: "settings" | "slack", by: string | null): Promise<boolean> {
  requireScope(install.orgId);
  const deleted = unwrap(await platformDb().from("slack_installs").delete().eq("id", install.id).select("id")) as Array<{ id: string }>;
  if (deleted.length === 0) return false;
  await appendLedgerEntryBestEffort(install.orgId, {
    actor: via === "slack" ? "system" : "human",
    domain: "system",
    action: "slack_uninstalled",
    summary: via === "slack" ? "Slack said the app was removed from its workspace" : "Disconnected the workspace's Slack",
    detail: { by, teamId: install.teamId, via },
  });
  return true;
}
