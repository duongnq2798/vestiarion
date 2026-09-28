import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import { ChevronGlyph } from "@/components/vx/Glyphs";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { HOME_PATH } from "@/components/vx/nav";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Workspaces" };

type OnboardingPageProps = {
  searchParams: Promise<{ new?: string | string[] }>;
};

/**
 * Where a signed-in person lands, and where they create a workspace. Signing
 * in sends people here by default, so one workspace still goes straight in;
 * `?new`, which the workspace switcher links to, stays here to list workspaces
 * and create another. Several: choose. None: create the first.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const user = await verifySession("/onboarding");
  const memberships = await membershipsOf(user.id);
  const query = await searchParams;
  if (memberships.length === 1 && query.new === undefined) redirect(orgHref(memberships[0].slug, HOME_PATH));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        {user.email && <span className="hidden max-w-[16rem] truncate text-sm text-ink-3 sm:block">{user.email}</span>}
        <form action={signOut}>
          <button type="submit" className="h-10 rounded-lg px-3 text-sm font-medium text-ink-2 transition-colors hover:bg-raised/70 hover:text-ink">
            Sign out
          </button>
        </form>
      </SiteHeader>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {memberships.length ? (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Choose a workspace</h1>
              <p className="mt-2 text-sm text-ink-3">Pick one to open. You can switch at any time from the navigation.</p>
              <ul className="mt-6 space-y-2">
                {memberships.map((membership) => (
                  <li key={membership.orgId}>
                    <Link
                      href={orgHref(membership.slug, HOME_PATH)}
                      className="surface-shadow group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-ink transition-colors hover:border-agent-line"
                    >
                      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-agent-line bg-agent-soft text-sm font-semibold text-agent">
                        {membership.name.trim().charAt(0).toUpperCase() || "W"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{membership.name}</span>
                        <span className="block font-mono text-xs capitalize text-ink-3">{membership.role} · {membership.mode}</span>
                      </span>
                      <ChevronGlyph className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-agent" />
                    </Link>
                  </li>
                ))}
              </ul>
              <h2 id="create-workspace" className="mt-10 scroll-mt-24 text-lg font-semibold text-ink">Create another workspace</h2>
              <div className="mt-4">
                <CreateWorkspaceForm />
              </div>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">No workspace yet</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-3">
                Create a workspace to try Vestiarion with simulated money. A teammate can also invite you to theirs.
              </p>
              <div id="create-workspace" className="mt-6 scroll-mt-24">
                <CreateWorkspaceForm />
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
