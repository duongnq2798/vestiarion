"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PipelineDiagram } from "./PipelineDiagram";
import { stepState } from "./steps";

/**
 * The loop told by scrolling (docs/superpowers/specs/2026-10-08-landing-motion-design.md M1): the steps in one column,
 * the diagram sticky beside them from `lg` up. The step crossing the middle of the viewport is the active one; the
 * steps and the diagram's parts take their state from it, and the CSS does the rest. Until the section nears the
 * viewport no step is chosen, so the server's HTML, and a page whose script never runs, shows every step lit.
 */
export function DecisionPipeline({ steps }: { steps: ReactNode[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    // The first step is chosen as the section comes within a quarter screen, so the others dim before they are read.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setActive((current) => current ?? 0);
        near.disconnect();
      },
      { rootMargin: "0px 0px 25% 0px" }
    );
    // A thin band through the middle of the viewport: the step inside it is the one being read.
    const middle = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    near.observe(element);
    for (const step of element.querySelectorAll<HTMLElement>("[data-step]")) middle.observe(step);
    return () => {
      near.disconnect();
      middle.disconnect();
    };
  }, []);

  const states = steps.map((_, index) => stepState(index, active));

  return (
    <div ref={root} className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div className="hidden lg:block">
        <div className="sticky top-24">
          <PipelineDiagram states={states} />
        </div>
      </div>
      <div className="relative">
        <span aria-hidden className="absolute bottom-3 left-[5px] top-3 w-px bg-ground/15" />
        <ol className="relative">
          {steps.map((step, index) => (
            <li key={index} data-step={index} data-state={states[index]} className="pipeline-step relative pb-14 pl-10 last:pb-0 lg:min-h-[46vh] lg:last:min-h-0">
              <span aria-hidden className="pipeline-node absolute left-0 top-1 size-[11px] rounded-full border-2" />
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
