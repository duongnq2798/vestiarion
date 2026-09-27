import type { ReactNode } from "react";
import { requireMembership } from "@/lib/auth/membership";

type OrgLayoutProps = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * Defence in depth only: in this Next version a layout does not control
 * whether its child segments render or appear in the RSC payload, so this
 * check alone would not stop a page from running. Each page under
 * `/o/[slug]` calls `requireMembership` itself before loading tenant data;
 * this call just means a request that never reaches a page (a bare fetch of
 * the layout's own boundary) is still covered.
 */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { slug } = await params;
  await requireMembership(slug);
  return children;
}
