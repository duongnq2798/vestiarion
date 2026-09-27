import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { membershipFor } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";

type OrgLayoutProps = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * Every product page passes through here. A non-member gets the same 404 as a
 * slug that does not exist, so the existence of another business is never
 * disclosed.
 */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { slug } = await params;
  const user = await verifySession(`/o/${slug}/console`);
  if (!(await membershipFor(user.id, slug))) notFound();
  return children;
}
