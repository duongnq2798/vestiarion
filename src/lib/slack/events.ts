import { withOrg } from "../dal/scope";
import { installOfTeam, removeInstall } from "./installs";
import type { SlackSettings } from "./settings";
import { slackRequestOf, verifySlackRequest } from "./verify";

/**
 * Slack's events (Slack design S13): verified first. Slack's URL check gets its own challenge back. When the app is
 * uninstalled from a Slack workspace, or its bot's token is revoked, that workspace's install and its links are
 * removed, and the removal is recorded as Slack's doing. Every other event is acknowledged and changes nothing, so Slack
 * never redelivers it.
 */

const ID = /^[A-Z][A-Z0-9]{1,31}$/;
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const ok = () => Response.json({ ok: true });

export async function handleEvent(request: Request, deps: { settings: SlackSettings }): Promise<Response> {
  const body = await request.text();
  if (!verifySlackRequest(slackRequestOf(request, body), deps.settings.signingSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(body));
  } catch {
    payload = null;
  }
  if (!payload) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (payload.type === "url_verification") return Response.json({ challenge: text(payload.challenge) });
  if (payload.type !== "event_callback") return ok();

  const event = record(payload.event);
  const kind = text(event?.type);
  const teamId = text(payload.team_id);
  if ((kind !== "app_uninstalled" && kind !== "tokens_revoked") || !ID.test(teamId)) return ok();
  const install = await installOfTeam(teamId);
  if (!install) return ok();
  if (kind === "tokens_revoked") {
    const bots = record(event?.tokens)?.bot;
    // Only this app's own bot token matters: a person's revoked token says nothing about the install.
    if (!install.botUserId || !Array.isArray(bots) || !bots.includes(install.botUserId)) return ok();
  }
  await withOrg(install.orgId, () => removeInstall(install, "slack", null));
  return ok();
}
