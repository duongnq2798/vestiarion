import { Fragment } from "react";
import { cn } from "@/components/ui/cn";
import { splitCodeSpans } from "@/lib/docs/headings";

/**
 * Text written in the operations' descriptions, which use two pieces of
 * Markdown: `code spans` and blank lines between paragraphs. Rendered with
 * the same classes the MDX components use, so a generated page reads like a
 * written one.
 */

export const CODE_CLASS = "rounded-md border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[0.8125em] text-ink [overflow-wrap:anywhere]";

export const LINK_CLASS =
  "font-medium text-agent underline [overflow-wrap:anywhere] decoration-agent-line underline-offset-4 transition-colors duration-150 ease-standard hover:decoration-agent";

/** One line of text, its code spans as `<code>`. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {splitCodeSpans(text).map((piece, index) =>
        piece.code ? (
          <code key={index} className={CODE_CLASS}>
            {piece.text}
          </code>
        ) : (
          <Fragment key={index}>{piece.text}</Fragment>
        )
      )}
    </>
  );
}

/** Paragraphs separated by blank lines. */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph, index) => (
          <p key={index} className={cn("my-4 leading-7 text-ink-2 [overflow-wrap:anywhere]", className)}>
            <InlineText text={paragraph} />
          </p>
        ))}
    </>
  );
}

/** A URL path that wraps only after a `/`, never inside a segment. */
export function PathText({ path }: { path: string }) {
  const segments = path.split(/(?<=\/)/);
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {segment}
        </Fragment>
      ))}
    </>
  );
}
