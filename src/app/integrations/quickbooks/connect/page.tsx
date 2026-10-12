import type { Metadata } from "next";
import { AccountingConnect, type ConnectSearchParams } from "@/components/AccountingConnect";

export const metadata: Metadata = { title: "Connect QuickBooks" };
export const dynamic = "force-dynamic";

/**
 * QuickBooks' Connect/Reconnect URL (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4, Q13),
 * registered as https://www.vestiarion.xyz/integrations/quickbooks/connect: the person picks the workspace, reads what
 * Vestiarion does with QuickBooks' data, ticks I agree, and continues to Intuit. Reading it has no side effect.
 */
export default function QuickBooksConnectPage({ searchParams }: { searchParams: ConnectSearchParams }) {
  return <AccountingConnect provider="quickbooks" searchParams={searchParams} />;
}
