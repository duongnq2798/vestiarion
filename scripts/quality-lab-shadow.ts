/**
 * Exports the shadow-mode decisions the Quality Lab replays (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-
 * design.md SX1-SX8): every agent decision on a bill made in shadow mode in the team's own workspaces on Arc testnet,
 * with the person's verdict on each, into src/lib/quality-lab/shadow-decisions.json. Customers' workspaces are never
 * read into it.
 *
 *   npm run quality-lab:shadow
 *
 * Reads the database in one read-only transaction and writes nothing to it. Needs the database variables
 * `npm run db:migrate` needs. Commit the file it writes, after reading it.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { Client } from "pg";
import { runShadowExport } from "./lib/quality-lab-shadow";

config({ path: [".env.local", ".env"], quiet: true });

function connectionString(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const ref = process.env.SUPABASE_PROJECT_ID;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!ref || !password) throw new Error("Set SUPABASE_PROJECT_ID and SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL) in .env.local");
  const region = process.env.SUPABASE_REGION ?? "us-east-1";
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const client = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const line = await runShadowExport({ client, write: (file, text) => writeFileSync(path.join(root, file), text, "utf8") });
    console.log(line);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
