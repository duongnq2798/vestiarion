import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { ChevronGlyph } from "@/components/vx/Glyphs";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { HOME_PATH } from "@/components/vx/nav";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Workspaces" };

/**
 * Where a signed-in person lands. One workspace: straight in. Several: choose.
 * None: said plainly — creating a workspace yourself arrives with self-serve
 * onboarding (Plan 3).
 */
export default async function OnboardingPage() {
  const user = await verifySession("/onboarding");
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) redirect(orgHref(memberships[0].slug, HOME_PATH));

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
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
            {memberships.length ? "Choose a workspace" : "No workspace yet"}
          </h1>
          {memberships.length ? (
            <>
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
            </>
          ) : (
            <p className="mt-3 text-sm leading-relaxed text-ink-3">
              You are signed in as {user.email ?? "this account"}, but no workspace has added you yet. Ask an owner to
              invite you. Creating your own workspace is coming shortly.
            </p>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
