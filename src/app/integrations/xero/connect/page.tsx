import type { Metadata } from "next";
import { AccountingConnect, type ConnectSearchParams } from "@/app/integrations/_accounting/AccountingConnect";

export const metadata: Metadata = { title: "Connect Xero" };
export const dynamic = "force-dynamic";

/**
 * Connecting Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X12): the workspace, the consent and
 * Continue to Xero; after Xero, the organisation picked when it authorized several.
 */
export default function XeroConnectPage({ searchParams }: { searchParams: ConnectSearchParams }) {
  return <AccountingConnect provider="xero" searchParams={searchParams} />;
}
