import { pauseWorkspaceAgent } from "../commands/agent";
import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { verifyLedger } from "../ledger";
import { takeSlackUserToken } from "../rate-limit";
import { todayFacts, waitingFacts } from "../telegram/today";
import { postToResponseUrl, type SlackMessage } from "./api";
import { connectAnswer, helpAnswer, ledgerAnswer, mrkdwn, textAnswer, todayAnswer, waitingAnswer } from "./blocks";
import { installOfTeam } from "./installs";
import { createLinkRequest, linkOf, slackActor, unlink } from "./links";
import type { SlackSettings } from "./settings";
import { slackRequestOf, verifySlackRequest } from "./verify";

/**
 * `/vestiarion` (Slack design S2, S4–S6). Verified before anything is read; answered at once with nothing, so a cold
 * start or a ledger check never runs into Slack's three seconds; the work runs after the response (`defer`) and its
 * answer is posted to the command's `response_url`. Only a member who connected their own Slack account is answered
 * from the workspace, as the membership is now; `connect` gives a one-time link to the person who asked, and only them.
 */

export interface SlashDeps {
  settings: SlackSettings;
  origin: string;
  fetchImpl?: typeof fetch;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  now?: () => Date;
}

const ID = /^[A-Z][A-Z0-9]{1,31}$/;
const HOOKS = "https://hooks.slack.com/";

export const NOT_INSTALLED =
  "This Slack workspace is not connected to Vestiarion. An owner or admin connects it from Settings in Vestiarion.";
const NO_LONGER_MEMBER = "You are no longer a member of the Vestiarion workspace this Slack is connected to.";
const SLOW_DOWN = "That is a lot of commands in a minute. Try again in a few seconds.";
const FAILED = "That did not work. Try again in a moment.";

interface SlashCommand {
  teamId: string;
  slackUserId: string;
  slackUserName: string | null;
  text: string;
}

async function workspaceOf(orgId: string): Promise<{ slug: string; name: string }> {
  return unwrap(await platformDb().from("orgs").select("slug, name").eq("id", orgId).single<{ slug: string; name: string }>());
}

/** The answer to one command, as the person who typed it may see it. */
export async function answerCommand(command: SlashCommand, deps: Pick<SlashDeps, "origin" | "now">): Promise<SlackMessage> {
  const { teamId, slackUserId, slackUserName } = command;
  const [word = "", ...rest] = command.text.trim().split(/\s+/);
  const sub = word.toLowerCase();

  const install = await installOfTeam(teamId);
  if (!install) return textAnswer(NOT_INSTALLED);
  if (sub === "connect") {
    const { code } = await createLinkRequest(teamId, slackUserId, slackUserName, deps.now?.());
    return connectAnswer(`${deps.origin}/integrations/slack/connect?code=${code}`);
  }

  const link = await linkOf(teamId, slackUserId);
  if (!link || link.orgId !== install.orgId) return helpAnswer(false);
  const actor = await slackActor(install, link);
  if (!actor) return textAnswer(NO_LONGER_MEMBER);
  const workspace = await workspaceOf(install.orgId);

  return withOrg(
    install.orgId,
    async () => {
      switch (sub) {
        case "today":
          return todayAnswer(workspace.name, await todayFacts(), `${deps.origin}/o/${workspace.slug}/console`);
        case "waiting":
          return waitingAnswer(workspace.name, await waitingFacts(), deps.origin, workspace.slug);
        case "ledger":
          return ledgerAnswer(workspace.name, await verifyLedger());
        case "pause": {
          const reason = rest.join(" ").slice(0, 280);
          const outcome = await pauseWorkspaceAgent(actor, { reason });
          // A pause is the workspace's news: the channel where it was typed sees it. A refusal is the person's alone.
          return outcome.ok
            ? textAnswer(`<@${slackUserId}> paused the agent${reason ? `: ${mrkdwn(reason)}` : ""}. It is resumed in Vestiarion.`, true)
            : textAnswer(mrkdwn(outcome.message));
        }
        case "disconnect":
          await unlink(link, "slack", link.userId);
          return textAnswer("Your Slack account is disconnected from Vestiarion. Type `/vestiarion connect` to connect it again.");
        default:
          return helpAnswer(true, workspace.name);
      }
    },
    { userId: link.userId }
  );
}

export async function handleSlashCommand(request: Request, deps: SlashDeps): Promise<Response> {
  const body = await request.text();
  if (!verifySlackRequest(slackRequestOf(request, body), deps.settings.signingSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = new URLSearchParams(body);
  const teamId = form.get("team_id") ?? "";
  const slackUserId = form.get("user_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  if (!ID.test(teamId) || !ID.test(slackUserId) || !responseUrl.startsWith(HOOKS)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const command: SlashCommand = { teamId, slackUserId, slackUserName: form.get("user_name"), text: form.get("text") ?? "" };

  deps.defer(async () => {
    let answer: SlackMessage;
    try {
      answer = takeSlackUserToken(`${teamId}:${slackUserId}`) ? await answerCommand(command, deps) : textAnswer(SLOW_DOWN);
    } catch (error) {
      // The team and the error, never the command's text: it can carry a reason someone typed.
      console.error("slack: command not answered", teamId, error instanceof Error ? error.message : "unknown error");
      answer = textAnswer(FAILED);
    }
    await postToResponseUrl(responseUrl, answer, deps.fetchImpl);
  });
  return new Response(null, { status: 200 });
}
