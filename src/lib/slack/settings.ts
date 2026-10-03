/**
 * The platform's one Slack app (Slack design S1), created from `integrations/slack/manifest.yaml`. The feature is off
 * unless all three variables are set: the app's client id and secret, for the install, and its signing secret, which
 * every request from Slack is checked against.
 */
export interface SlackSettings {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/** Slack's client ids are two numbers joined by a dot. */
const CLIENT_ID = /^[0-9]+\.[0-9]+$/;

export function slackSettingsFromEnv(env: Record<string, string | undefined> = process.env): SlackSettings | null {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  if (!clientId || !clientSecret || !signingSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Slack is off: SLACK_CLIENT_ID is not a Slack client id");
    return null;
  }
  return { clientId, clientSecret, signingSecret };
}

/** Where Slack sends a person back after they install the app: the deployment's own callback. */
export function slackRedirectUri(origin: string): string {
  return `${origin}/api/slack/oauth`;
}
