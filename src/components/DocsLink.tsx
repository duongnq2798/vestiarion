import { BookOpen, CirclePlay } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { videoFor } from "@/lib/docs/videos";

/**
 * A section's link to the docs page that explains it, beside its heading, as API keys and Webhooks have it: the book
 * and "Docs", named for screen readers by what the page explains. When that page has a walkthrough video, "Watch" and
 * its length follow, opening the guide at the video (`GUIDE_VIDEOS`). `tests/docs-links.test.tsx` holds every one to a
 * page, and a heading, the docs have.
 */
export function DocsLink({ href, topic }: { href: string; topic: string }) {
  const docs = (
    <Button asChild variant="link">
      <Link href={href} aria-label={`Docs: ${topic}`}>
        <BookOpen aria-hidden />
        Docs
      </Link>
    </Button>
  );
  const video = videoFor(href);
  if (!video) return docs;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
      {docs}
      <WatchLink video={video} />
    </span>
  );
}

/** "Watch" and the video's length, opening its guide at the video, named for screen readers by the video's title. */
export function WatchLink({ video, size }: { video: { title: string; duration: string; watch: string }; size?: "sm" }) {
  const inner = (
    <Link href={video.watch} aria-label={`Watch: ${video.title}, ${video.duration}`}>
      <CirclePlay aria-hidden />
      Watch
      <span className="font-mono text-xs font-normal text-ink-3">{video.duration}</span>
    </Link>
  );
  return size === "sm" ? (
    <Button asChild size="sm" variant="ghost">
      {inner}
    </Button>
  ) : (
    <Button asChild variant="link">
      {inner}
    </Button>
  );
}
