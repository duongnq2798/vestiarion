import type { Actor } from "../commands/actor";
import { approvePayable, rejectPayable, returnPayable } from "../commands/payables";
import { withOrg } from "../dal/scope";
import { takeSlackUserToken } from "../rate-limit";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { postToResponseUrl, type SlackMessage } from "./api";
import { DRAFT_USED, mrkdwn, outcomeLine, withOutcome } from "./blocks";
import { NOT_INSTALLED, workspaceOf } from "./commands";
import { installOfTeam, type SlackInstall } from "./installs";
import { addChosenDraft, cancelChosenDraft, readChosenInvoice, type ChosenMessage } from "./intake";
import { linkOf, slackActor, type SlackLink } from "./links";
import type { SlackSettings } from "./settings";
import { readCard } from "./state";
import { slackRequestOf, verifySlackRequest } from "./verify";

/**
 * Clicks and shortcuts from Slack (Slack design S9, S10, S15). Verified before anything is read; answered at once
 * with nothing; worked after the response (`defer`), the answer posted to the `response_url` Slack sent. Only a member
 * who connected their own Slack account acts, as the membership is now, and only in the workspace this Slack serves:
 *
 * - a card's button decides its payable through the command every surface shares, with the card it answers, so the
 *   chat's rules and every check the console makes run. A decision that changed the payable rewrites the message to
 *   say who did what; a refusal is said to the person who clicked, and to nobody else;
 * - "Add invoice" on a message reads the invoice it holds into a draft only that member sees, and the
 *   draft's buttons add it, or drop it (src/lib/slack/intake.ts).
 *
 * A link button needs nothing.
 */

export interface InteractionDeps {
  settings: SlackSettings;
  /** The deployment's origin, for the links in an answer. */
  origin: string;
  fetchImpl?: typeof fetch;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  keys?: MasterKey[];
  now?: () => number;
}

const ID = /^[A-Z][A-Z0-9]{1,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOOKS = "https://hooks.slack.com/";
const DECISIONS = { vx_approve: "approve", vx_reject: "reject", vx_return: "return" } as const;
/** The message shortcut's callback id, as `integrations/slack/manifest.yaml` declares it. */
export const ADD_INVOICE_SHORTCUT = "vx_add_invoice";
const DRAFT_PRESSES = { vx_draft_received: "received", vx_draft_not_received: "not_received", vx_draft_cancel: "cancel" } as const;

const CONNECT_FIRST = "Connect your Slack account to Vestiarion first: type `/vestiarion connect`.";
const NO_LONGER_MEMBER = "You are no longer a member of the Vestiarion workspace this Slack is connected to.";
const NOTHING_DECIDED = "Nothing was decided.";
const NOTHING_ADDED = "Nothing was added.";
const BAD_CARD = "This button no longer works: decide this payable in Vestiarion. Nothing was decided.";
const SLOW_DOWN = "That is a lot of clicks in a minute. Try again in a few seconds.";
const DECISION_FAILED = "That did not work. Try again in a moment: nothing is paid twice.";
const INTAKE_FAILED = "That did not work. Try again in a moment.";

/** An answer for the person who clicked alone; the message stays as it was. */
function toClicker(text: string): SlackMessage {
  return { response_type: "ephemeral", replace_original: false, text };
}

interface Member {
  install: SlackInstall;
  link: SlackLink;
  actor: Actor;
}

/** The member a click or a shortcut came from, as the membership is now; or what to tell them, ending with `nothing`. */
async function memberOf(teamId: string, slackUserId: string, nothing: string): Promise<Member | SlackMessage> {
  const install = await installOfTeam(teamId);
  if (!install) return toClicker(NOT_INSTALLED);
  const link = await linkOf(teamId, slackUserId);
  if (!link || link.orgId !== install.orgId) return toClicker(`${CONNECT_FIRST} ${nothing}`);
  const actor = await slackActor(install, link);
  if (!actor) return toClicker(`${NO_LONGER_MEMBER} ${nothing}`);
  return { install, link, actor };
}

const isMember = (value: Member | SlackMessage): value is Member => "actor" in value;

interface Click {
  teamId: string;
  slackUserId: string;
  decision: "approve" | "reject" | "return";
  token: string;
  messageText: string;
  blocks: unknown[];
}

async function decide(click: Click, deps: InteractionDeps): Promise<SlackMessage> {
  const member = await memberOf(click.teamId, click.slackUserId, NOTHING_DECIDED);
  if (!isMember(member)) return member;
  const { install, link, actor } = member;
  const card = readCard(click.token, deps.keys ?? masterKeysFromEnv(), deps.now?.() ?? Date.now());
  if (!card || card.org !== install.orgId) return toClicker(BAD_CARD);

  const shown = { decidedAt: card.decidedAt, addressHash: card.addressHash };
  return withOrg(
    install.orgId,
    async () => {
      const outcome =
        click.decision === "approve"
          ? await approvePayable(actor, { invoiceId: card.invoice, card: shown })
          : click.decision === "reject"
            ? await rejectPayable(actor, { invoiceId: card.invoice, reason: "", card: shown })
            : await returnPayable(actor, { invoiceId: card.invoice, card: shown });
      if (!outcome.ok && !outcome.changed) return toClicker(mrkdwn(outcome.message));
      return {
        replace_original: true,
        text: click.messageText || "The agent's decisions",
        blocks: withOutcome(click.blocks, card.invoice, outcomeLine(click.decision, click.slackUserId, outcome)),
      };
    },
    { userId: link.userId }
  );
}

/** "Add invoice" on a message: its invoice read into a draft, for the member who chose it (S15). */
async function readChosen(teamId: string, slackUserId: string, message: ChosenMessage, deps: InteractionDeps): Promise<SlackMessage> {
  const member = await memberOf(teamId, slackUserId, NOTHING_ADDED);
  if (!isMember(member)) return member;
  const { install, link, actor } = member;
  const workspace = await workspaceOf(install.orgId);
  const now = deps.now;
  return withOrg(
    install.orgId,
    () =>
      readChosenInvoice(install, link, actor, message, {
        origin: deps.origin,
        workspace,
        fetchImpl: deps.fetchImpl,
        keys: deps.keys,
        ...(now ? { now: () => new Date(now()) } : {}),
      }),
    { userId: link.userId }
  );
}

/** A draft's button: added with the goods as pressed, or dropped; only through the member's own link (S15). */
async function pressDraft(
  teamId: string,
  slackUserId: string,
  press: { kind: (typeof DRAFT_PRESSES)[keyof typeof DRAFT_PRESSES]; draftId: string },
  deps: InteractionDeps
): Promise<SlackMessage> {
  if (!UUID.test(press.draftId)) return toClicker(DRAFT_USED);
  const member = await memberOf(teamId, slackUserId, NOTHING_ADDED);
  if (!isMember(member)) return member;
  const { install, link, actor } = member;
  const workspace = await workspaceOf(install.orgId);
  const now = deps.now;
  const intake = { workspace, ...(now ? { now: () => new Date(now()) } : {}) };
  return withOrg(
    install.orgId,
    () =>
      press.kind === "cancel"
        ? cancelChosenDraft(link, press.draftId, intake)
        : addChosenDraft(install, link, actor, { draftId: press.draftId, goodsReceived: press.kind === "received" }, intake),
    { userId: link.userId }
  );
}

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The files a message holds, as the intake needs them: name, type, size and Slack's download address. */
function filesOf(value: unknown): ChosenMessage["files"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const file = record(item);
    const url = text(file?.url_private_download) || text(file?.url_private);
    if (!file || !url) return [];
    return [{ name: text(file.name), mimetype: text(file.mimetype), size: typeof file.size === "number" ? file.size : 0, url }];
  });
}

const acknowledged = () => new Response(null, { status: 200 });

export async function handleInteraction(request: Request, deps: InteractionDeps): Promise<Response> {
  const body = await request.text();
  if (!verifySlackRequest(slackRequestOf(request, body), deps.settings.signingSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(new URLSearchParams(body).get("payload") ?? ""));
  } catch {
    payload = null;
  }
  if (!payload) return Response.json({ error: "invalid_request" }, { status: 400 });

  // What was asked, and what it says when it does nothing: nothing to do (a link button, another shortcut) is acknowledged.
  let work: ((teamId: string, slackUserId: string) => Promise<SlackMessage>) | null = null;
  let nothing = NOTHING_DECIDED;
  let failed = DECISION_FAILED;
  if (payload.type === "message_action" && text(payload.callback_id) === ADD_INVOICE_SHORTCUT) {
    const message = record(payload.message);
    const chosen: ChosenMessage = { files: filesOf(message?.files), text: text(message?.text) };
    work = (teamId, slackUserId) => readChosen(teamId, slackUserId, chosen, deps);
    nothing = NOTHING_ADDED;
    failed = INTAKE_FAILED;
  } else if (payload.type === "block_actions") {
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const action = record(actions[0]);
    const actionId = text(action?.action_id);
    const pressed = DRAFT_PRESSES[actionId as keyof typeof DRAFT_PRESSES];
    const decision = DECISIONS[actionId as keyof typeof DECISIONS];
    if (pressed) {
      const draftId = text(action?.value);
      work = (teamId, slackUserId) => pressDraft(teamId, slackUserId, { kind: pressed, draftId }, deps);
      nothing = NOTHING_ADDED;
      failed = INTAKE_FAILED;
    } else if (decision) {
      const message = record(payload.message);
      const token = text(action?.value);
      const messageText = text(message?.text);
      const blocks = Array.isArray(message?.blocks) ? (message.blocks as unknown[]) : [];
      work = (teamId, slackUserId) => decide({ teamId, slackUserId, decision, token, messageText, blocks }, deps);
    }
  }
  if (!work) return acknowledged();

  const teamId = text(record(payload.team)?.id) || text(record(payload.user)?.team_id);
  const slackUserId = text(record(payload.user)?.id);
  const responseUrl = text(payload.response_url);
  if (!ID.test(teamId) || !ID.test(slackUserId) || !responseUrl.startsWith(HOOKS)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const run = work;
  deps.defer(async () => {
    let reply: SlackMessage;
    try {
      reply = takeSlackUserToken(`${teamId}:${slackUserId}`) ? await run(teamId, slackUserId) : toClicker(`${SLOW_DOWN} ${nothing}`);
    } catch (error) {
      console.error("slack: interaction not handled", teamId, error instanceof Error ? error.message : "unknown error");
      reply = toClicker(failed);
    }
    await postToResponseUrl(responseUrl, reply, deps.fetchImpl);
  });
  return acknowledged();
}
