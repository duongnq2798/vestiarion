import { NextResponse } from "next/server";
import { accountingProvider } from "@/lib/accounting-providers";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { asanaProviderFromEnv } from "@/lib/asana/provider";
import { syncAsanaConnection, type AsanaSyncOutcome } from "@/lib/asana/workspace";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { sweepAccounting } from "@/lib/connectors/sweep";
import { crmProvider } from "@/lib/crm-providers";
import { googleDriveProviderFromEnv, type GoogleDriveProvider } from "@/lib/googledrive/provider";
import { syncGoogleDriveConnection } from "@/lib/googledrive/workspace";
import { jiraProviderFromEnv, type JiraProvider } from "@/lib/jira/provider";
import { syncJiraConnection, type JiraSyncOutcome } from "@/lib/jira/workspace";
import { linearProviderFromEnv, type LinearProvider } from "@/lib/linear/provider";
import { syncLinearConnection, type LinearSyncOutcome } from "@/lib/linear/workspace";

/** A sweep stops starting syncs after 240 seconds (docs/superpowers/specs/2026-10-12-xero-connector-design.md X7). */
export const maxDuration = 300;

/**
 * Brings bills in from the accounting tools workspaces connected, and deals from their CRMs (HubSpot connector H7), and
 * reads again the Asana tasks and the Linear and Jira issues linked to milestones (Asana acceptance A11, Linear
 * acceptance LN12, Jira acceptance JR16), and reads the Google Drive folder each workspace chose for new files (Google
 * Drive intake GD7), without a person:
 * bearer-protected, run every 15 minutes by Supabase Cron (`supabase/cron/watches.sql`) and by hand from
 * `.github/workflows/accounting-sync.yml`.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Counts only: this body is printed into the workflow's log, and the repository is public.
    // One Asana provider, one Linear provider, one Jira provider and one Google Drive provider for the run, each when it
    // is set up on this deployment.
    const asana = asanaProviderFromEnv();
    const linear = linearProviderFromEnv();
    const jira = jiraProviderFromEnv();
    const googleDrive = googleDriveProviderFromEnv();
    return NextResponse.json(
      await sweepAccounting({
        providerFor: accountingProvider,
        crm: { providerFor: crmProvider, sync: crmSyncInScope },
        work: {
          providerFor: (id) => (id === "asana" ? asana : id === "linear" ? linear : id === "jira" ? jira : null),
          sync: (connectionId, provider): Promise<{ outcome: AsanaSyncOutcome | LinearSyncOutcome | JiraSyncOutcome }> =>
            provider.id === "linear"
              ? syncLinearConnection(connectionId, provider as LinearProvider)
              : provider.id === "jira"
                ? syncJiraConnection(connectionId, provider as JiraProvider)
                : syncAsanaConnection(connectionId, provider as NonNullable<typeof asana>),
        },
        intake: {
          providerFor: (id) => (id === "googledrive" ? googleDrive : null),
          sync: (connectionId, provider) => syncGoogleDriveConnection(connectionId, provider as GoogleDriveProvider),
        },
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("accounting sync failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "The accounting sync failed." }, { status: 500 });
  }
}
