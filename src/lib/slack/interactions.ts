import { approvePayable, rejectPayable, returnPayable } from "../commands/payables";
import { withOrg } from "../dal/scope";
import { takeSlackUserToken } from "../rate-limit";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { postToResponseUrl, type SlackMessage } from "./api";
import { mrkdwn, outcomeLine, withOutcome } from "./blocks";
import { NOT_INSTALLED } from "./commands";
import { installOfTeam } from "./installs";
import { linkOf, slackActor } from "./links";
import type { SlackSettings } from "./settings";
import { readCard } from "./state";
import { slackRequestOf, verifySlackRequest } from "./verify";

/**
 * A click on a card (Slack design S9, S10). Verified before anything is read; answered at once with nothing; decided
 * after the response (`defer`). Only a member who connected their own Slack account may decide, as the membership is
 * now, and only on a card Vestiarion signed for the workspace this Slack serves; the decision runs through the command
 * every surface shares, with the card it answers, so the chat's rules and every check the console makes run. A
 * decision that changed the payable rewrites the message through `response_url` to say who did what; a refusal is said
 * to the person who clicked, and to nobody else. A link button (to the console, to a transaction) needs nothing.
 */

export interface InteractionDeps {
  settings: SlackSettings;
  fetchImpl?: typeof fetch;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  keys?: MasterKey[];
  now?: () => number;
}

const ID = /^[A-Z][A-Z0-9]{1,31}$/;
const HOOKS = "https://hooks.slack.com/";
const DECISIONS = { vx_approve: "approve", vx_reject: "reject", vx_return: "return" } as const;

const CONNECT_FIRST = "Connect your Slack account to Vestiarion first: type `/vestiarion connect`. Nothing was decided.";
const BAD_CARD = "This button no longer works: decide this payable in Vestiarion. Nothing was decided.";
const NO_LONGER_MEMBER = "You are no longer a member of the Vestiarion workspace this Slack is connected to. Nothing was decided.";
const SLOW_DOWN = "That is a lot of clicks in a minute. Try again in a few seconds. Nothing was decided.";
const FAILED = "That did not work. Try again in a moment: nothing is paid twice.";

/** An answer for the person who clicked alone; the message stays as it was. */
function toClicker(text: string): SlackMessage {
  return { response_type: "ephemeral", replace_original: false, text };
}

interface Click {
  teamId: string;
  slackUserId: string;
  decision: "approve" | "reject" | "return";
  token: string;
  messageText: string;
  blocks: unknown[];
}

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");

async function decide(click: Click, deps: InteractionDeps): Promise<SlackMessage> {
  const install = await installOfTeam(click.teamId);
  if (!install) return toClicker(NOT_INSTALLED);
  const link = await linkOf(click.teamId, click.slackUserId);
  if (!link || link.orgId !== install.orgId) return toClicker(CONNECT_FIRST);
  const card = readCard(click.token, deps.keys ?? masterKeysFromEnv(), deps.now?.() ?? Date.now());
  if (!card || card.org !== install.orgId) return toClicker(BAD_CARD);
  const actor = await slackActor(install, link);
  if (!actor) return toClicker(NO_LONGER_MEMBER);

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
  if (payload.type !== "block_actions") return new Response(null, { status: 200 });

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = record(actions[0]);
  const decision = DECISIONS[text(action?.action_id) as keyof typeof DECISIONS];
  // A link button opens a page; there is nothing to decide.
  if (!decision) return new Response(null, { status: 200 });

  const teamId = text(record(payload.team)?.id) || text(record(payload.user)?.team_id);
  const slackUserId = text(record(payload.user)?.id);
  const responseUrl = text(payload.response_url);
  if (!ID.test(teamId) || !ID.test(slackUserId) || !responseUrl.startsWith(HOOKS)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const message = record(payload.message);
  const click: Click = {
    teamId,
    slackUserId,
    decision,
    token: text(action?.value),
    messageText: text(message?.text),
    blocks: Array.isArray(message?.blocks) ? (message.blocks as unknown[]) : [],
  };

  deps.defer(async () => {
    let reply: SlackMessage;
    try {
      reply = takeSlackUserToken(`${teamId}:${slackUserId}`) ? await decide(click, deps) : toClicker(SLOW_DOWN);
    } catch (error) {
      console.error("slack: click not decided", teamId, error instanceof Error ? error.message : "unknown error");
      reply = toClicker(FAILED);
    }
    await postToResponseUrl(responseUrl, reply, deps.fetchImpl);
  });
  return new Response(null, { status: 200 });
}
