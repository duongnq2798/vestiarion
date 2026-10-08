"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";
import { frameAt, snippetCost, type Snippet } from "./snippets";

/** Typing takes about this long, whatever the snippet's length, at no fewer than this many characters a second. */
const TYPING_MS = 2600;
const MIN_CHARS_PER_MS = 0.045;
/** A space that holds an empty line's height. */
const NBSP = "\u00a0";

/**
 * One snippet, typed out the first time the terminal is seen and again on **Replay** (docs/superpowers/specs/2026-10-08-
 * landing-motion-design.md M3). The server's HTML, reduced motion and a screen reader get the whole snippet at once:
 * the typing is drawn over a copy that is always complete, and only the drawing is hidden from assistive technology.
 */
export function Terminal({ snippet }: { snippet: Snippet }) {
  const total = snippetCost(snippet.lines);
  const [budget, setBudget] = useState(Number.POSITIVE_INFINITY);
  const [run, setRun] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(false);

  useEffect(() => {
    const element = box.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let observer: IntersectionObserver | null = null;
    const type = () => {
      const start = performance.now();
      const rate = Math.max(total / TYPING_MS, MIN_CHARS_PER_MS);
      const tick = (now: number) => {
        const spent = (now - start) * rate;
        setBudget(spent >= total ? Number.POSITIVE_INFINITY : spent);
        if (spent < total) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    if (seen.current) {
      // A tab chosen, or Replay: the terminal is in view, so type at once.
      frame = requestAnimationFrame(() => {
        setBudget(0);
        type();
      });
    } else {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          observer?.disconnect();
          seen.current = true;
          setBudget(0);
          type();
        },
        { rootMargin: "0px 0px -15% 0px" }
      );
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [snippet, run, total]);

  const frames = frameAt(snippet.lines, budget);

  return (
    <div ref={box} className="overflow-hidden rounded-2xl border border-ink/10 bg-ink text-ground shadow-raised">
      <div className="flex items-center justify-between gap-3 border-b border-ground/10 px-4 py-2.5">
        <p className="min-w-0 truncate font-mono text-xs text-ground/60">{snippet.context}</p>
        <CopyButton value={snippet.copy} size="sm" className="shrink-0 text-ground/70 hover:bg-ground/10 hover:text-ground" />
      </div>
      <div className="relative">
        <pre className="sr-only">{snippet.lines.map((line) => line.text).join("\n")}</pre>
        {/* A line too long for the frame wraps under itself, and never scrolls the frame sideways. Every line holds its
            whole text from the start, the part not typed yet invisible, so the frame never grows as the typing reaches
            a line that wraps; the caret takes no room. */}
        <pre aria-hidden className="min-h-[21.5rem] overflow-hidden px-4 py-4 font-mono text-[0.78rem] leading-[1.7] sm:px-5">
          {snippet.lines.map((line, index) => {
            const frame = frames[index];
            const typed = frame.shown ? frame.text : "";
            const rest = line.text.slice(typed.length);
            return (
              <span
                key={index}
                className={cn(
                  "block whitespace-pre-wrap break-words pl-[2ch] indent-[-2ch]",
                  line.kind === "command" && "text-ground",
                  line.kind === "code" && "text-ground/85",
                  line.kind === "output" && "text-proof-line",
                  line.kind === "note" && "text-ground/45"
                )}
              >
                {line.kind === "command" && <span className={cn("select-none text-agent-line", !frame.shown && "invisible")}>$ </span>}
                {typed}
                {frame.caret && (
                  <span className="relative">
                    <span className="terminal-caret absolute left-px top-[0.1em] h-[1.05em] w-[0.55em] bg-agent-line" />
                  </span>
                )}
                <span className="invisible">{rest || (line.text ? "" : NBSP)}</span>
              </span>
            );
          })}
        </pre>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-ground/10 px-4 py-2.5">
        <Link href={snippet.guide.href} className="font-mono text-xs font-semibold text-agent-line underline-offset-4 hover:underline">
          {snippet.guide.label} →
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setRun((current) => current + 1)} className="text-ground/70 hover:bg-ground/10 hover:text-ground">
          <RotateCcw aria-hidden />
          Replay
        </Button>
      </div>
    </div>
  );
}
