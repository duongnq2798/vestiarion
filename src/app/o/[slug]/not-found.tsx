import Link from "next/link";
import { signOut } from "@/app/login/actions";

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
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">Workspace not found</h1>
      <p className="mt-3 text-sm text-ink-3">
        This workspace does not exist, or your account is not a member of it.
      </p>
      <Link href="/onboarding" className="mt-6 text-sm font-semibold text-agent hover:underline">
        Your workspaces
      </Link>
      <form action={signOut} className="mt-8">
        <button type="submit" className="text-sm text-ink-3 underline hover:text-ink">Sign out</button>
      </form>
    </main>
  );
}
