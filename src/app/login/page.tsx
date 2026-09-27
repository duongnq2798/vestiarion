import LoginForm from "@/components/auth/LoginForm";
import { loginErrorMessage } from "@/lib/auth/messages";
import { safeNext } from "@/lib/auth/routes";
import { signInWithGoogle } from "./actions";

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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">Sign in to Vestiarion</h1>
      <p className="mt-2 text-sm text-ink-3">We email you a link. No password to remember or leak.</p>
      {error && <p role="alert" className="mt-4 rounded-md border border-refused p-3 text-sm text-refused">{error}</p>}
      <div className="surface-shadow mt-6 rounded-2xl border border-line bg-surface p-5">
        <LoginForm next={next} />
        {googleSignInEnabled() && (
          <form action={signInWithGoogle} className="mt-4 border-t border-line pt-4">
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="w-full rounded-md border border-ink-3 px-3.5 py-2 text-sm font-medium text-ink hover:bg-raised">
              Continue with Google
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
