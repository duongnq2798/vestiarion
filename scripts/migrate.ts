/**
 * Applies everything in supabase/migrations to the configured Supabase
 * project, in filename order.
 *
 *   npm run db:migrate
 *
 * Needs SUPABASE_PROJECT_ID and SUPABASE_DATABASE_PASSWORD (Project Settings
 * > Database). Each file runs inside one transaction, so a failure leaves
 * nothing half-applied. The migrations are written to be idempotent, so
 * re-running is safe.
 */
import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

config({ path: [".env.local", ".env"], quiet: true });

function connectionString(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const ref = process.env.SUPABASE_PROJECT_ID;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!ref || !password) {
    throw new Error(
      "Set SUPABASE_PROJECT_ID and SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL) in .env.local"
    );
  }
  // Session pooler: reachable over IPv4, unlike the direct db.<ref> host.
  const region = process.env.SUPABASE_REGION ?? "us-east-1";
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("No migrations found.");
    return;
  }

  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), "utf8");
      process.stdout.write(`applying ${file} … `);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("commit");
        console.log("ok");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }

  console.log("\nMigrations applied. Next: npm run seed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
