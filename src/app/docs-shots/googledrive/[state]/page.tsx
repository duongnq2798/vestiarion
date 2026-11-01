import type { Metadata } from "next";
import { notFound } from "next/navigation";
import GoogleDrivePanel from "@/components/GoogleDrivePanel";
import InboxEmails from "@/components/InboxEmails";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import { googleDrivePanelView } from "@/lib/googledrive/views";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { GOOGLE_DRIVE_CONNECTION, GOOGLE_DRIVE_FIGURES, GOOGLE_DRIVE_FOLDER, GOOGLE_DRIVE_NOW, REVIEW_COUNTERPARTIES, REVIEW_ROWS } from "../../googledrive-fixture";

/**
 * Bills dropped into a Google Drive folder, with sample data (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md
 * Screens), as Linear's /docs-shots/linear: the Google Drive card in Settings, connected, with its folder and figures;
 * the same card before a folder is chosen, asking for the folder's link; and the review list on Bills & receivables with
 * a file from the folder ready to add beside an emailed invoice. Every view is built by the pages' own functions from
 * the fixture. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a
 * 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Google Drive intake states", robots: { index: false, follow: false } };

const STATES = ["settings", "folder", "review"] as const;

type Props = { params: Promise<{ state: string }> };

export default async function GoogleDriveStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const slug = DESIGN_SLUG;

  if (state === "review") {
    return (
      <MotionProvider>
        <main id="main" data-googledrive-state={state} className="min-h-dvh bg-ground">
          <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
            <PageHead title={sectionTitle("invoices")} sub="Your bills, what the agent decided on each, and why." />
            <InboxEmails orgSlug={slug} emails={REVIEW_ROWS} canAdd counterparties={REVIEW_COUNTERPARTIES} driveCheck={{ folderName: GOOGLE_DRIVE_FOLDER.folderName }} />
          </div>
        </main>
      </MotionProvider>
    );
  }

  // `folder`: connected, no folder chosen yet, nothing read.
  const view = googleDrivePanelView({
    connection: GOOGLE_DRIVE_CONNECTION,
    folder: state === "settings" ? GOOGLE_DRIVE_FOLDER : null,
    figures: state === "settings" ? GOOGLE_DRIVE_FIGURES : { read30d: 0, waiting: 0, added30d: 0 },
    nowMs: GOOGLE_DRIVE_NOW,
  });
  return (
    <MotionProvider>
      <main id="main" data-googledrive-state={state} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
          <PageHead title={sectionTitle("settings")} sub="How this workspace connects to other tools." />
          <GoogleDrivePanel orgSlug={slug} view={view} canManage canCheck notice={null} />
        </div>
      </main>
    </MotionProvider>
  );
}
