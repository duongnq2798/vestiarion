/**
 * Encrypts this deployment's env secrets into an organization's row, then
 * reads them back and re-derives the ledger key id to prove the round trip.
 * Prints ids and presence only — never a secret.
 *
 *   npm run org:adopt-env -- founding --expect-key-id 9b03458d9a617871
 *
 * The app reads each organization's secrets from its own row, never from env
 * — this command is the only thing that still reads the env copies, so they
 * can be removed from hosting once production is verified.
 */
import crypto from "node:crypto";
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { configFromEnv } = await import("../src/lib/config");
  const { createContext } = await import("../src/lib/context");
  const { isValidSlug } = await import("../src/lib/auth/org-paths");
  const { adoptEnvSecrets } = await import("../src/lib/platform/adopt");
  const { decryptSecret, masterKeysFromEnv } = await import("../src/lib/secrets");
  const { ledgerKeyId } = await import("../src/lib/ledger-keys");

  const args = process.argv.slice(2);
  const slug = args[0];
  const flag = args.indexOf("--expect-key-id");
  const expected = flag >= 0 ? args[flag + 1] : undefined;
  if (!slug || !isValidSlug(slug) || !expected) {
    throw new Error("usage: npm run org:adopt-env -- <slug> --expect-key-id <16 hex>");
  }

  const db = createContext(configFromEnv(process.env)).db;
  const org = await db.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) throw new Error(`no organization with slug ${slug}`);

  const keys = masterKeysFromEnv();
  const adopted = adoptEnvSecrets({ orgId: org.data.id, env: process.env, keys, expectLedgerKeyId: expected });

  const update = await db
    .from("orgs")
    .update({
      ledger_signing_key_enc: adopted.ledger_signing_key_enc,
      circle_api_key_enc: adopted.circle_api_key_enc,
      circle_entity_secret_enc: adopted.circle_entity_secret_enc,
    })
    .eq("id", org.data.id);
  if (update.error) throw new Error(update.error.message);

  const stored = await db.from("orgs").select("ledger_signing_key_enc").eq("id", org.data.id).single();
  if (stored.error) throw new Error(stored.error.message);
  const pem = decryptSecret(stored.data.ledger_signing_key_enc, { orgId: org.data.id, column: "ledger_signing_key_enc" }, keys);
  const roundTrip = ledgerKeyId(crypto.createPrivateKey(pem));
  if (roundTrip !== expected) throw new Error(`stored key re-derives to ${roundTrip}, not ${expected}`);

  console.log(`ledger key ${roundTrip} stored for ${slug} under master key ${keys[0].id}, and re-derived from the database.`);
  console.log(`circle api key: ${adopted.circle_api_key_enc ? "stored" : "absent"} · entity secret: ${adopted.circle_entity_secret_enc ? "stored" : "absent"}`);
  console.log("The app reads this from the organization's row now, never from env. The env copies were only needed for this command and can be removed from hosting once production is verified.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
