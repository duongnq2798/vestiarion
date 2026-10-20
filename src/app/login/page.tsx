import type { Metadata } from "next";
import LoginForm from "@/components/auth/LoginForm";
import { PublicMain } from "@/components/public/PublicMain";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { SubmitButton } from "@/components/ui/SubmitButton";
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
      <PublicMain>
        <div className="mx-auto w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Sign in to Vestiarion</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">We email you a link. No password to remember or leak.</p>
          {/* Coming from the landing page's call to action (shadow mode ticked): say what follows the link, so signing in reads as a step. */}
          {next.startsWith("/onboarding?") && new URLSearchParams(next.slice(next.indexOf("?") + 1)).get("shadow") === "1" && (
            <p className="mt-3 rounded-xl border border-agent-line/60 bg-agent-soft/50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-2">
              Next, you name your workspace and add one of your bills to see what the agent decides. No wallet or funds needed to start.
            </p>
          )}
          {error && (
            <Callout tone="refused" role="alert" className="mt-4">
              {error}
            </Callout>
          )}
          <Card elevation="flat" className="mt-6 p-6 sm:p-8">
            <LoginForm next={next} />
            {googleSignInEnabled() && (
              <form action={signInWithGoogle} className="mt-4 border-t border-line pt-4">
                <input type="hidden" name="next" value={next} />
                <SubmitButton variant="secondary" pendingLabel="Opening Google…" className="w-full">
                  Continue with Google
                </SubmitButton>
              </form>
            )}
          </Card>
          <p className="mt-5 text-center text-xs leading-relaxed text-ink-3">No account yet? The same link creates one.</p>
        </div>
      </PublicMain>
      <SiteFooter compact />
    </div>
  );
}
