import type { Metadata } from "next";
import { AccountingLaunch } from "@/components/AccountingLaunch";

export const metadata: Metadata = { title: "QuickBooks" };
export const dynamic = "force-dynamic";

/**
 * QuickBooks' Launch URL (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4), registered as
 * https://www.vestiarion.xyz/integrations/quickbooks: a signed-in person lands on their workspace's QuickBooks settings,
 * or picks the workspace when they have several. Not there unless QuickBooks is configured.
 */
export default function QuickBooksIntegrationPage() {
  return <AccountingLaunch provider="quickbooks" />;
}
