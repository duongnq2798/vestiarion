import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";

type OnboardingPageProps = {
  searchParams: Promise<{ new?: string | string[] }>;
};

/**
 * Where a signed-in person lands, and where they create a workspace. Signing
 * in sends people here by default, so one workspace still goes straight in;
 * `?new`, which the product shell links to, stays here to list workspaces and
 * create another. Several: choose. None: create the first.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const user = await verifySession("/onboarding");
  const memberships = await membershipsOf(user.id);
  const query = await searchParams;
  if (memberships.length === 1 && query.new === undefined) redirect(orgHref(memberships[0].slug, "/console"));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      {memberships.length ? (
        <>
          <h1 className="text-2xl font-semibold text-ink">Choose a workspace</h1>
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
          <h2 className="mt-10 text-lg font-semibold text-ink">Create another workspace</h2>
          <div className="mt-4">
            <CreateWorkspaceForm />
          </div>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-ink">No workspace yet</h1>
          <p className="mt-3 text-sm text-ink-3">
            Create a workspace to try Vestiarion with simulated money. A teammate can also invite you to theirs.
          </p>
          <div className="mt-6">
            <CreateWorkspaceForm />
          </div>
        </>
      )}
      <form action={signOut} className="mt-8">
        <button type="submit" className="text-sm text-ink-3 underline hover:text-ink">Sign out</button>
      </form>
    </main>
  );
}
