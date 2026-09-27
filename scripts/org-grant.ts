/**
 * Gives a person a role in an organization. For the operator: the founding
 * organization has no owner until this runs.
 *
 *   npm run org:grant -- founding you@example.com owner
 *
 * The person must have signed in once, so that an account exists.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { configFromEnv } = await import("../src/lib/config");
  const { createContext } = await import("../src/lib/context");
  const { FOUNDING_ORG_SLUG, isValidSlug } = await import("../src/lib/auth/org-paths");
  const { isOrgRole } = await import("../src/lib/auth/roles");

  const [slug, emailArg, role] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  if (!slug || !isValidSlug(slug) || !email || !isOrgRole(role)) {
    throw new Error("usage: npm run org:grant -- <slug> <email> <owner|admin|approver|viewer>");
  }

  if (slug !== FOUNDING_ORG_SLUG) {
    throw new Error(
      `Until data is scoped per organization (Plan 2), only the founding organization can have members; refusing to grant a role in ${slug}.`
    );
  }

  const db = createContext(configFromEnv(process.env)).db;

  const org = await db.from("orgs").select("id, name").eq("slug", slug).maybeSingle();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) throw new Error(`no organization with slug ${slug}`);

  let userId: string | null = null;
  for (let page = 1; !userId; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) userId = match.id;
    if (data.users.length < 200) break;
  }
  if (!userId) throw new Error(`no account for ${email}; sign in once at /login, then run this again`);

  const upsert = await db
    .from("memberships")
    .upsert({ org_id: org.data.id, user_id: userId, role }, { onConflict: "org_id,user_id" });
  if (upsert.error) throw new Error(upsert.error.message);

  const { appendLedgerEntry } = await import("../src/lib/ledger");
  const entry = await appendLedgerEntry({
    actor: "system",
    domain: "system",
    action: "membership_granted",
    summary: `Granted ${role} in ${org.data.name}`,
    detail: { orgId: org.data.id, userId, role },
  });

  console.log(`${email} is now ${role} of ${org.data.name} (${slug}). Ledger entry #${entry.seq}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
