import type { Metadata } from "next";
import { AccountingConnect, type ConnectSearchParams } from "@/app/integrations/_accounting/AccountingConnect";

export const metadata: Metadata = { title: "Connect Zoho Books" };
export const dynamic = "force-dynamic";

/**
 * Connecting Zoho Books (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z5, Z11): the workspace, the
 * consent and Continue to Zoho; after Zoho, the organization picked when the token reaches several.
 */
export default function ZohoBooksConnectPage({ searchParams }: { searchParams: ConnectSearchParams }) {
  return <AccountingConnect provider="zohobooks" searchParams={searchParams} />;
}
