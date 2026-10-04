import crypto from "node:crypto";

/**
 * The platform's one GitHub App (docs/superpowers/specs/2026-10-04-github-app-design.md G1), registered by the
 * platform's owner. The feature is off unless all five variables are set: the app's id and slug, for its JWT and its
 * install page; its client id and secret, to check who is connecting; and its private key, which signs the JWT.
 */
export interface GitHubAppSettings {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

const APP_ID = /^[0-9]{1,12}$/;
/** As GitHub makes an app's slug from its name: lower case, digits and dashes. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function githubAppSettingsFromEnv(env: Record<string, string | undefined> = process.env): GitHubAppSettings | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  // A dashboard often keeps a PEM on one line, its newlines written as the two characters \n (G7).
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim().replaceAll("\\n", "\n");
  if (!appId || !slug || !clientId || !clientSecret || !privateKey) return null;
  // Never the values themselves: only which one was not usable.
  if (!APP_ID.test(appId)) {
    console.warn("GitHub is off: GITHUB_APP_ID is not a GitHub App id");
    return null;
  }
  if (!SLUG.test(slug)) {
    console.warn("GitHub is off: GITHUB_APP_SLUG is not a GitHub App slug");
    return null;
  }
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    console.warn("GitHub is off: GITHUB_APP_PRIVATE_KEY is not a private key");
    return null;
  }
  return { appId, slug, clientId, clientSecret, privateKey };
}

/** Where GitHub sends a person back after they install the app and authorize it: the deployment's own callback. */
export function githubCallbackUri(origin: string): string {
  return `${origin}/api/github/callback`;
}
