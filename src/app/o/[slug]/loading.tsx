import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { FrameBanners } from "@/components/vx/FrameContext";
import { WorkspaceHeader } from "@/components/vx/WorkspaceHeader";

/**
 * Shown the moment a section link is followed, while the page gathers its
 * data; the navigation around it stays in place. The same header — with what
 * the layout knows, and the page's own status still to come — and the same
 * frame and spacing as `ProductShell`, so the page lands without a jump. The
 * body is neutral: a title, then two cards, since most sections have no
 * figures across the top.
 */
export default function WorkspaceLoading() {
  return (
    <>
      {/* The agent's last run is the page's to say: its line is held open, so the page lands without a jump. */}
      <WorkspaceHeader activity={<span aria-hidden className="skeleton inline-block h-3 w-40 rounded-lg align-middle" />} />
      <div aria-busy="true" className={cn(CONTENT_FRAME, "pb-10 pt-4 sm:pt-6 lg:pt-7")}>
        <p role="status" className="sr-only">
          Loading…
        </p>
        <FrameBanners />
        <div className="mb-7 border-b border-line pb-5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="mt-3 h-4 w-full max-w-xl" />
        </div>
        <div className="space-y-4">
          {[0, 1].map((card) => (
            <Card key={card} className="p-5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="mt-3 h-5 w-3/5" />
              <Skeleton className="mt-5 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-4/5" />
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
