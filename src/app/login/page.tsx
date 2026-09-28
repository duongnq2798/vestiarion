import type { Metadata } from "next";
import LoginForm from "@/components/auth/LoginForm";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { loginErrorMessage } from "@/lib/auth/messages";
import { safeNext } from "@/lib/auth/routes";
import { signInWithGoogle } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

/** Google appears only once the operator has enabled the provider in Supabase and said so here. */
function googleSignInEnabled(): boolean {
  return process.env.AUTH_GOOGLE_ENABLED === "true";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : null);
  const error = loginErrorMessage(typeof query.error === "string" ? query.error : null);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Sign in to Vestiarion</h1>
          <p className="mt-2 text-sm text-ink-3">We email you a link. No password to remember or leak.</p>
          {error && <p role="alert" className="mt-4 rounded-lg border border-refused-line bg-refused-soft p-3 text-sm text-refused">{error}</p>}
          <div className="surface-shadow mt-6 rounded-2xl border border-line bg-surface p-5 sm:p-6">
            <LoginForm next={next} />
            {googleSignInEnabled() && (
              <form action={signInWithGoogle} className="mt-4 border-t border-line pt-4">
                <input type="hidden" name="next" value={next} />
                <button type="submit" className="h-11 w-full rounded-xl border border-line-strong px-3.5 text-sm font-medium text-ink transition-colors hover:bg-raised">
                  Continue with Google
                </button>
              </form>
            )}
          </div>
          <p className="mt-5 text-center text-xs leading-relaxed text-ink-3">No account yet? The same link creates one.</p>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
