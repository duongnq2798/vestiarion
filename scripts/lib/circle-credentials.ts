import type { ChainConfig } from "../../src/lib/config";

/**
 * The Circle credentials a script acts with for one organization: its own, as
 * its scope decrypted them from its row, and never this environment's. With
 * the environment's credentials, a script working for any other organization
 * would mint wallets in the founding organization's Circle entity and write
 * them onto that organization's rows (R14).
 */
export function circleCredentialsFrom(chain: ChainConfig, slug: string): { apiKey: string; entitySecret: string } {
  if (chain.credentialsUnreadable) {
    throw new Error(`${slug}'s Circle credentials are stored but could not be read: ${chain.credentialsUnreadable}`);
  }
  const { circleApiKey: apiKey, circleEntitySecret: entitySecret } = chain;
  if (!apiKey || !entitySecret) {
    const missing = [apiKey ? null : "API key", entitySecret ? null : "entity secret"].filter(Boolean).join(" and ");
    throw new Error(
      `${slug} is missing its Circle ${missing}. An organization's Circle credentials are stored encrypted on the ` +
        "organization, never read from this environment; for the founding organization, npm run org:adopt-env stores them."
    );
  }
  return { apiKey, entitySecret };
}
