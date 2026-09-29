import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsShell } from "@/components/docs/DocsShell";
import { publicOrigin } from "@/lib/docs/origin";

/** Public: no session and no key. The pages are static, built from `content/docs`. */
export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin()),
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
