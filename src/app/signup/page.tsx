import { redirect } from "next/navigation";
import { safeNext } from "@/lib/auth/routes";

type SignupPageProps = { searchParams: Promise<{ next?: string | string[] }> };

/** An email link signs a new person up and an existing one in; there is one form for both. */
export default async function SignupPage({ searchParams }: SignupPageProps) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : null);
  redirect(`/login?next=${encodeURIComponent(next)}`);
}
