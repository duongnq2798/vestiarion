import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/**
 * `notFound()` for `/o/[slug]/*` lands here. Deliberately vague: whether the
 * slug does not exist and whether this account is simply not a member of it
 * are indistinguishable from the outside, and staying vague is what keeps a
 * workspace's existence from leaking to a stranger who guesses its slug.
 *
 * Next.js does not pass params to a not-found boundary, so this reads none.
 */
export default function OrgNotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.11em] text-agent">404</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">Workspace not found</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-3">
            This workspace does not exist, or your account is not a member of it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/onboarding" className="brand-shadow inline-flex h-10 items-center rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5">
              Your workspaces
            </Link>
            <form action={signOut}>
              <button type="submit" className="h-10 rounded-xl border border-line-strong px-4 text-sm font-medium text-ink-2 transition-colors hover:border-agent-line hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
