/**
 * Subscribes Circle accounts to transaction notifications
 * (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N6): the platform's hosted account, then every
 * workspace with its own Circle credentials stored. A workspace connected from now on is subscribed when it connects;
 * this covers the hosted account and the ones connected before. Found or made, so it is safe to run again. It prints
 * each account's result, never a key.
 *
 *   npm run circle:subscribe
 *   npm run circle:subscribe -- https://another-deployment.example   (that deployment's origin instead of production)
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main(argv: string[]) {
  const { defaultCircleClient } = await import("../src/lib/circle/check");
  const { ensureNotificationSubscription, notificationEndpoint } = await import("../src/lib/circle/notifications");
  const { PRODUCTION_ORIGIN } = await import("../src/lib/public-origin");
  const { platformDb, unwrap } = await import("../src/lib/dal");
  const { withOrg } = await import("../src/lib/dal/scope");
  const { currentOrgConfig } = await import("../src/lib/context");

  const endpoint = notificationEndpoint(argv[0] ?? PRODUCTION_ORIGIN);
  console.log(`Subscribing Circle accounts to ${endpoint}`);

  const apiKey = process.env.HOSTED_CIRCLE_API_KEY?.trim();
  const entitySecret = process.env.HOSTED_CIRCLE_ENTITY_SECRET?.trim();
  if (apiKey && entitySecret) {
    console.log(`hosted account: ${await ensureNotificationSubscription(defaultCircleClient({ apiKey, entitySecret }), endpoint)}`);
  } else {
    console.log("hosted account: HOSTED_CIRCLE_API_KEY and HOSTED_CIRCLE_ENTITY_SECRET are not set here; skipped");
  }

  const orgs = unwrap(
    await platformDb().from("orgs").select("id, slug").not("circle_api_key_enc", "is", null).order("slug")
  ) as Array<{ id: string; slug: string }>;
  for (const org of orgs) {
    try {
      const result = await withOrg(org.id, async () => {
        const { circleApiKey, circleEntitySecret } = currentOrgConfig().chain;
        if (!circleApiKey || !circleEntitySecret) return "credentials unreadable; skipped";
        return ensureNotificationSubscription(defaultCircleClient({ apiKey: circleApiKey, entitySecret: circleEntitySecret }), endpoint);
      });
      console.log(`${org.slug}: ${result}`);
    } catch (error) {
      console.log(`${org.slug}: failed (${error instanceof Error ? error.message : String(error)})`);
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
