"use client";

import { Check, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { HashText, Receipt, Seal, Verdict } from "../evidence/Evidence";
import { HOLD_MS, PRINT_AT, REPLAY_MS, SCENARIOS, type ReplayScenario } from "./scenarios";

/** The newest entries of the live ledger, newest first: only what the landing page may show. */
export interface ChainHeadEntry {
  seq: number;
  hash: string;
  domain: string;
  action: string;
}

const GENESIS = "0".repeat(64);

function at(ms: number): CSSProperties {
  return { "--d": `${ms}ms` } as CSSProperties;
}

function Stage({ number, name, delay, children }: { number: string; name: string; delay: number; children: ReactNode }) {
  return (
    <li className="replay-lit -mx-2 grid gap-x-3 gap-y-1 rounded-lg px-2 py-2 min-[430px]:grid-cols-[4.75rem_minmax(0,1fr)]" style={at(delay)}>
      <span className="pt-px font-mono text-xs font-semibold uppercase tracking-[0.12em] text-agent">
        {number} <span className="text-ink min-[430px]:block">{name}</span>
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

/**
 * One decision printed as a receipt, stage by stage: what the agent saw, what
 * the model argued, what code allowed and the signature that closes it. The
 * printing is CSS, so it runs before hydration and is instant under reduced
 * motion; this component only chooses which replay runs and when the next
 * one starts. Every line is in the DOM from the start, so a screen reader
 * reads the whole receipt and the slip never changes height.
 */
function ReceiptSlip({ scenario, prev, frozen }: { scenario: ReplayScenario; prev: string; frozen: boolean }) {
  const refused = scenario.outcome.tone === "refused";
  return (
    <Receipt slipClassName="relative overflow-hidden px-4 py-6 sm:px-6" className="relative">
      <div data-frozen={frozen || undefined} className="replay">
        <span aria-hidden className="replay-scan pointer-events-none absolute inset-x-0 h-10 bg-linear-to-b from-transparent to-agent-soft/80" />
        <div className="replay-print flex items-baseline justify-between gap-3" style={at(PRINT_AT.head)}>
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-ink">Decision receipt</span>
          <span className="font-mono text-xs text-ink-3">ap · pay</span>
        </div>

        <div className="replay-print mt-4 flex items-end justify-between gap-4 border-b border-dashed border-line-strong pb-4" style={at(PRINT_AT.item)}>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">{scenario.counterparty}</p>
            <p className="mt-0.5 truncate text-xs text-ink-3">{scenario.reference}</p>
          </div>
          <p className="shrink-0 text-right font-mono text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            {scenario.amount}
            <span className="ml-1 text-xs font-medium text-ink-3">USDC</span>
          </p>
        </div>

        <ol className="mt-2 space-y-0.5">
          <Stage number="01" name="Observe" delay={PRINT_AT.observe}>
            <ul className="space-y-1 text-[0.8125rem] leading-snug text-ink-2">
              {scenario.observe.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Stage>

          <Stage number="02" name="Reason" delay={PRINT_AT.reason}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              <span>model says</span>
              <Verdict tone="agent" className="px-1.5 py-0 text-[0.75rem]">{scenario.model.action}</Verdict>
              <span className="font-mono">confidence {scenario.model.confidence}</span>
            </p>
            <p className="mt-1.5 font-serif text-[0.9375rem] italic leading-snug text-ink-2">“{scenario.model.argument}”</p>
          </Stage>

          <Stage number="03" name="Enforce" delay={PRINT_AT.enforce}>
            <ul className="space-y-1">
              {scenario.checks.map((check, index) => (
                <li
                  key={check.rule}
                  className={cn(
                    "replay-print -mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-0.5 [&>svg]:mt-0.5",
                    !check.passed && "bg-refused-soft"
                  )}
                  style={at(PRINT_AT.enforce + (index + 1) * PRINT_AT.check)}
                >
                  {check.passed ? (
                    <Check aria-hidden className="size-3.5 shrink-0 text-proof" strokeWidth={3} />
                  ) : (
                    <X aria-hidden className="size-3.5 shrink-0 text-refused" strokeWidth={3} />
                  )}
                  <span className={cn("min-w-0 break-words font-mono text-xs", check.passed ? "text-ink-2" : "font-semibold text-refused")}>
                    {check.rule}
                    <span className="sr-only">{check.passed ? ", passed" : ", failed"}</span>
                    {check.note && (
                      <span className={cn("block", check.passed ? "text-ink-3" : "text-refused")}>{check.note}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Stage>

          <Stage number="04" name="Sign" delay={PRINT_AT.sign}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Verdict tone={scenario.outcome.tone} className="text-sm">
                  {refused ? "Refused by code" : scenario.outcome.verdict}
                </Verdict>
                <p className="mt-1.5 text-xs leading-snug text-ink-2">{scenario.outcome.detail}</p>
              </div>
              <Seal
                tone={scenario.outcome.tone}
                words={scenario.outcome.seal}
                className="replay-stamp -my-3 size-[4.75rem] shrink-0 sm:size-20"
                style={at(PRINT_AT.sign + 120)}
              />
            </div>
          </Stage>
        </ol>

        <div className="replay-print mt-3 grid grid-cols-2 gap-3 border-t border-dashed border-line-strong pt-3 font-mono text-xs text-ink-3" style={at(PRINT_AT.foot)}>
          <span>
            hash <HashText value={scenario.hash} className="text-ink-2" />
          </span>
          <span className="text-right">
            prev <HashText value={prev} className="text-ink-2" />
          </span>
        </div>
      </div>
    </Receipt>
  );
}

function ChainStub({ entry, depth }: { entry: ChainHeadEntry; depth: number }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 font-mono text-xs shadow-surface",
        depth === 0 ? "mx-3" : "mx-6 opacity-70"
      )}
    >
      <span className="font-semibold text-ink">#{entry.seq}</span>
      <span className="min-w-0 truncate text-ink-3">
        {entry.domain} · {entry.action}
      </span>
      <HashText value={entry.hash} className="ml-auto shrink-0 text-ink-2" />
    </div>
  );
}

export function EvidenceReplay({ head }: { head: ChainHeadEntry[] }) {
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const [stillMotion, setStillMotion] = useState(false);
  const figure = useRef<HTMLElement>(null);

  // Reduced motion: every receipt is shown whole and nothing switches by itself.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setStillMotion(query.matches);
      if (query.matches) setAutoplay(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // A replay nobody can see neither prints nor advances.
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    let inView = true;
    const update = () => setOffscreen(!inView || document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    if (!autoplay || offscreen) return;
    const timer = window.setTimeout(() => {
      setIndex((current) => (current + 1) % SCENARIOS.length);
      setRun((current) => current + 1);
    }, REPLAY_MS + HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [autoplay, offscreen, run]);

  const choose = (next: number) => {
    setIndex(next);
    setRun((current) => current + 1);
    setAutoplay(false);
    setFrozen(false);
  };

  const togglePlay = () => {
    if (autoplay) {
      setAutoplay(false);
      setFrozen(true);
    } else {
      setAutoplay(true);
      setFrozen(false);
      setIndex((current) => (current + 1) % SCENARIOS.length);
      setRun((current) => current + 1);
    }
  };

  const prev = head[0]?.hash ?? GENESIS;

  return (
    <figure ref={figure} aria-labelledby="replay-title" className="relative">
      <div aria-hidden className="absolute -inset-x-6 -inset-y-8 -z-10 rounded-full bg-[radial-gradient(60%_50%_at_70%_20%,var(--color-agent-soft),transparent),radial-gradient(50%_45%_at_20%_85%,var(--color-proof-soft),transparent)] blur-2xl" />
      <div className="rounded-2xl border border-line bg-surface/75 p-2 shadow-raised backdrop-blur-sm sm:p-2.5">
        <div className="flex items-center gap-2 px-1.5 pb-2 pt-0.5">
          <div role="group" aria-label="Choose a replay" className="flex rounded-full border border-line bg-ground/80 p-0.5">
            {SCENARIOS.map((item, itemIndex) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                aria-pressed={itemIndex === index}
                onClick={() => choose(itemIndex)}
                className={cn(
                  "h-7 rounded-full",
                  itemIndex === index &&
                    (item.id === "refused"
                      ? "bg-refused text-on-agent shadow-control hover:bg-refused hover:text-on-agent"
                      : "bg-proof text-on-agent shadow-control hover:bg-proof hover:text-on-agent")
                )}
              >
                {item.tab}
              </Button>
            ))}
          </div>
          {!stillMotion && (
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={togglePlay}
              aria-label={autoplay ? "Pause the replay" : "Play the replays"}
              className="ml-auto rounded-full"
            >
              {autoplay ? <Pause aria-hidden /> : <Play aria-hidden />}
            </Button>
          )}
        </div>

        <div className="ledger-grid rounded-xl border border-line/70 bg-ground/70 px-2.5 pb-4 pt-3 sm:px-4">
          {/* Both receipts share one cell, so the slip is always as tall as the
              taller one and switching replays never moves the page. */}
          <div className="grid">
            {SCENARIOS.map((item, itemIndex) => (
              <div key={item.id} className={cn("col-start-1 row-start-1", itemIndex !== index && "invisible")} aria-hidden={itemIndex !== index || undefined}>
                <ReceiptSlip
                  key={itemIndex === index ? run : "idle"}
                  scenario={item}
                  prev={prev}
                  frozen={itemIndex !== index || frozen || offscreen}
                />
              </div>
            ))}
          </div>

          {head.length > 0 && (
            <div aria-label="The live ledger's newest entries" role="group">
              <div aria-hidden className="chain-link-line mx-auto h-5 w-px text-ink-3" />
              <p className="mb-1.5 flex items-center justify-center gap-1.5 font-mono text-xs uppercase tracking-[0.14em] text-proof">
                <span aria-hidden className="size-1.5 rounded-full bg-proof shadow-[0_0_0_3px_var(--color-proof-soft)]" />
                Live ledger head
              </p>
              <ChainStub entry={head[0]} depth={0} />
              {head[1] && (
                <>
                  <div aria-hidden className="chain-link-line mx-auto h-4 w-px text-ink-3" />
                  <ChainStub entry={head[1]} depth={1} />
                </>
              )}
            </div>
          )}
        </div>

        <figcaption id="replay-title" className="px-2 pb-1 pt-2.5 text-xs leading-relaxed text-ink-3">
          A replay with illustrative vendors and amounts. The stages, rule names and outcomes are the agent’s own{head.length > 0 ? "; the entries beneath it are the live signed ledger." : "."}
        </figcaption>
      </div>
    </figure>
  );
}
