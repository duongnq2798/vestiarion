/**
 * Gives a person a role in an organization. For the operator: the founding
 * organization has no owner until this runs.
 *
 *   npm run org:grant -- founding you@example.com owner
 *
 * The person must have signed in once, so that an account exists. Invitations
 * (Plan 3b) are the product's own way for a member to bring someone else into
 * a workspace; this stays the operator's tool, for the founding organization
 * and for anyone self-serve invitations can't yet reach. The last-owner
 * trigger (migration 0020) is what now keeps a sole owner from being
 * downgraded or removed out from under a workspace.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { configFromEnv } = await import("../src/lib/config");
  const { createContext } = await import("../src/lib/context");
  const { isValidSlug } = await import("../src/lib/auth/org-paths");
  const { isOrgRole } = await import("../src/lib/auth/roles");

  const [slug, emailArg, role] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  if (!slug || !isValidSlug(slug) || !email || !isOrgRole(role)) {
    throw new Error("usage: npm run org:grant -- <slug> <email> <owner|admin|approver|viewer>");
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

  // The grant is recorded on the chain of the organization it was made in,
  // signed with that organization's own key.
  const { withOrg } = await import("../src/lib/dal/scope");
  const { appendLedgerEntry } = await import("../src/lib/ledger");
  const grantedIn = org.data;
  const entry = await withOrg(grantedIn.id, () =>
    appendLedgerEntry({
      actor: "system",
      domain: "system",
      action: "membership_granted",
      summary: `Granted ${role} in ${grantedIn.name}`,
      detail: { orgId: grantedIn.id, userId, role },
    })
  );

  console.log(`${email} is now ${role} of ${org.data.name} (${slug}). Ledger entry #${entry.seq}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
