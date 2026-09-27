import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";

/**
 * Where a signed-in person lands. One workspace: straight in. Several: choose.
 * None: said plainly — creating a workspace yourself arrives with self-serve
 * onboarding (Plan 3).
 */
export default async function OnboardingPage() {
  const user = await verifySession("/onboarding");
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) redirect(orgHref(memberships[0].slug, "/console"));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">
        {memberships.length ? "Choose a workspace" : "No workspace yet"}
      </h1>
      {memberships.length ? (
        <ul className="mt-6 space-y-2">
          {memberships.map((membership) => (
            <li key={membership.orgId}>
              <Link
                href={orgHref(membership.slug, "/console")}
                className="surface-shadow flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-ink hover:bg-raised"
              >
                <span>{membership.name}</span>
                <span className="font-mono text-xs text-ink-3">{membership.role} · {membership.mode}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-3">
          You are signed in as {user.email ?? "this account"}, but no workspace has added you yet. Ask an owner to
          invite you. Creating your own workspace is coming shortly.
        </p>
      )}
      <form action={signOut} className="mt-8">
        <button type="submit" className="text-sm text-ink-3 underline hover:text-ink">Sign out</button>
      </form>
    </main>
  );
}
