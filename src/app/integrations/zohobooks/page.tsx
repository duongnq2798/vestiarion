import type { Metadata } from "next";
import { AccountingLaunch } from "@/app/integrations/_accounting/AccountingLaunch";

export const metadata: Metadata = { title: "Zoho Books" };
export const dynamic = "force-dynamic";

/**
 * Zoho Books for a signed-in person (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z1): their
 * workspace's Zoho Books settings, at once when they have one workspace, and a pick when they have several. Not there
 * unless Zoho Books is configured.
 */
export default function ZohoBooksIntegrationPage() {
  return <AccountingLaunch provider="zohobooks" />;
}
