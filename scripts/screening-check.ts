/**
 * Screens one name with the screening provider the environment names, to check a key before it goes into the
 * deployment (docs/superpowers/specs/2026-10-21-screening-providers-design.md SP5). Prints the verdict, the best matches
 * and how long it took; never the key.
 *
 *   npm run screening:check -- "Zenith Trading LLC"
 *
 * It reads SCREENING_PROVIDER, SCREENING_API_URL and SCREENING_API_KEY (or OPENSANCTIONS_API_URL and
 * OPENSANCTIONS_API_KEY) from .env.local, .env or the shell.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.error('Name a counterparty to screen: npm run screening:check -- "Zenith Trading LLC"');
    process.exit(2);
  }
  const { checkScreening } = await import("../src/lib/screening/check");
  const { ok, lines } = await checkScreening(process.env, name);
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}

void main();
