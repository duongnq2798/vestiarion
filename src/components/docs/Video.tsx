import { Children, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { isoDuration, videoProblem } from "@/lib/docs/videos";

export interface VideoProps {
  /** The MP4, by its public path: `/docs/videos/<name>.mp4`. */
  src: string;
  /** The image shown until the video plays: its title card. */
  poster: string;
  /** What the video is called; it names the player for a screen reader. */
  title: string;
  /** What it shows, and where it was recorded. */
  caption: string;
  /** Its length as minutes and seconds, `1:52`. */
  duration: string;
  /** The transcript, written between the tags in the MDX: the words spoken and shown, in order. */
  children?: ReactNode;
}

/**
 * A walkthrough video in a guide: the browser's own player, framed as a docs
 * card, with its title, length and caption below and its transcript under
 * "Read the transcript". It loads nothing until someone presses play
 * (`preload="none"`, the poster holding its 16:9 place), never plays on its
 * own or loops, and is served from this site: no embed, nothing that sets a
 * cookie. A `<Video>` that leaves out an attribute or its transcript fails the
 * page's render, so the build, rather than show a broken player. In the `.md`
 * view it is a link to the file, its caption and its transcript
 * (`MDX_TO_MARKDOWN` in src/lib/docs/markdown.ts).
 */
export function Video({ src, poster, title, caption, duration, children }: VideoProps) {
  const problem = videoProblem({ src, poster, title, caption, duration }, Children.toArray(children).length > 0);
  if (problem) throw new Error(problem);
  return (
    <div className="my-7">
      <Card asChild>
        <figure className="overflow-hidden">
          <video controls preload="none" playsInline poster={poster} aria-label={title} className="block aspect-video h-auto w-full bg-raised">
            <source src={src} type="video/mp4" />
            <a href={src}>Download the video</a>
          </video>
          <figcaption className="border-t border-line px-4 py-3 sm:px-5">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="text-[0.9375rem] font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{title}</span>
              <span className="font-mono text-xs text-ink-3">
                <span className="sr-only">Length: </span>
                <time dateTime={isoDuration(duration)!}>{duration}</time>
              </span>
            </span>
            <span className="mt-1 block text-sm leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{caption}</span>
          </figcaption>
        </figure>
      </Card>
      <Disclosure summary="Read the transcript" className="mt-3">
        <div className="text-ink-2 [&_p]:my-2 [&_p]:text-[0.9375rem] [&_p]:leading-relaxed [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">{children}</div>
      </Disclosure>
    </div>
  );
}
