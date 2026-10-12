import type { Metadata } from "next";
import { AccountingLaunch } from "@/components/AccountingLaunch";

export const metadata: Metadata = { title: "Xero" };
export const dynamic = "force-dynamic";

/**
 * Xero for a signed-in person (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4): their workspace's Xero
 * settings, at once when they have one workspace, and a pick when they have several. Not there unless Xero is
 * configured.
 */
export default function XeroIntegrationPage() {
  return <AccountingLaunch provider="xero" />;
}
