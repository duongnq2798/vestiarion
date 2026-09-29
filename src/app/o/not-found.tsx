import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SubmitButton } from "@/components/ui/SubmitButton";
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
          <p>
            <Eyebrow className="text-agent">404</Eyebrow>
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">Workspace not found</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-3">This workspace does not exist, or your account is not a member of it.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/onboarding">Your workspaces</Link>
            </Button>
            <form action={signOut}>
              <SubmitButton variant="secondary" icon={<LogOut />} pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
