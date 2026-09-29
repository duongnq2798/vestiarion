import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsShell } from "@/components/docs/DocsShell";
import { publicOrigin } from "@/lib/public-origin";
import { buildSearchIndex } from "@/lib/docs/search-index";

/** Public: no session and no key. The pages are static, built from `content/docs`. */
export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin()),
};

/** The search index is built here, with the pages, and handed to the shell's search dialog. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell searchIndex={buildSearchIndex()}>{children}</DocsShell>;
}
