import type { ReactNode } from "react";
import type { StepState } from "./steps";

/**
 * The loop drawn as a line diagram (docs/superpowers/specs/2026-10-08-landing-motion-design.md M1), one part per step:
 * the book the agent reads, the model's node, the code's gate (the treasury's arch) with its two outputs, Circle on
 * Arc, and the chain of signed entries. Each part takes its step's state; the CSS in landing-hero.css lights it, runs a
 * pulse down the path into the active part, and brings the newest entry in when Sign is read. Decoration only: the
 * steps beside it say everything it shows.
 */

const W = 460;
const H = 596;
const CX = W / 2;

const DOMAINS = ["Compliance", "Payables", "Contractors", "Treasury", "Forecast"] as const;
const TILE = { w: 84, h: 30, gap: 8 };

/** The four entries of an illustrative cycle: the refusal lands on one, the payment on the next. */
const ENTRIES = [
  { seq: 1041, what: "screened", hash: "3c9e…3a71", tone: "plain" },
  { seq: 1042, what: "refused", hash: "9f02…e0b5", tone: "refused" },
  { seq: 1043, what: "paid", hash: "b4e1…c0d8", tone: "proof" },
  { seq: 1044, what: "hold", hash: "e7a2…1f96", tone: "plain" },
] as const;
const ENTRY = { w: 104, h: 62, gap: 12, y: 526 };
const entryX = (index: number) => 4 + index * (ENTRY.w + ENTRY.gap);
const entryMid = (index: number) => entryX(index) + ENTRY.w / 2;

/** The paths into each part, so its pulse can run along the same line. */
const INTO_REASON = `M${CX} 122 V166`;
const INTO_ENFORCE = `M${CX} 236 V282`;
const INTO_ACT = `M${CX} 378 V414`;
const INTO_SIGN = `M${CX} 468 V496 H${entryMid(2)} V${ENTRY.y}`;
const REFUSED = `M150 344 H34 V496 H${entryMid(1)} V${ENTRY.y}`;

function Part({ state, tone, children }: { state: StepState; tone: "ground" | "agent" | "refused" | "proof"; children: ReactNode }) {
  return (
    <g className="pl-part" data-state={state} data-tone={tone}>
      {children}
    </g>
  );
}

/** A path, and the pulse that runs along it while its part is being read. */
function Wire({ d, dashed = false, className }: { d: string; dashed?: boolean; className?: string }) {
  return (
    <>
      <path d={d} className={`pl-line ${className ?? ""}`} strokeWidth="1.25" strokeDasharray={dashed ? "3 5" : undefined} />
      <path d={d} className="pl-pulse" pathLength={100} />
    </>
  );
}

function Check({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y} l3 3 l6 -7`} className="pl-line pl-ok" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />;
}

export function PipelineDiagram({ states }: { states: StepState[] }) {
  const [observe, reason, enforce, act, sign] = states;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="pipeline-diagram w-full overflow-visible font-mono">
      {/* 01 Observe: what the agent reads each cycle, gathered into the book. */}
      <Part state={observe} tone="ground">
        {DOMAINS.map((domain, index) => {
          const x = 2 + index * (TILE.w + TILE.gap);
          const mid = x + TILE.w / 2;
          return (
            <g key={domain}>
              <rect x={x} y={4} width={TILE.w} height={TILE.h} rx={7} className="pl-box" strokeWidth="1" />
              <text x={mid} y={23} textAnchor="middle" fontSize="10" className="pl-text">
                {domain}
              </text>
              <path d={`M${mid} 34 C${mid} 64 ${CX} 62 ${CX} 94`} className="pl-line" strokeWidth="1" strokeDasharray="2 4" />
            </g>
          );
        })}
        <rect x={CX - 62} y={94} width={124} height={28} rx={14} className="pl-box" strokeWidth="1" />
        <text x={CX} y={112} textAnchor="middle" fontSize="10.5" className="pl-text">
          the book
        </text>
      </Part>

      {/* 02 Reason: the model argues for an action. */}
      <Part state={reason} tone="agent">
        <Wire d={INTO_REASON} />
        <rect x={100} y={166} width={260} height={70} rx={12} className="pl-box" strokeWidth="1.25" />
        <text x={118} y={189} fontSize="10" letterSpacing="1.6" className="pl-text pl-strong">
          MODEL
        </text>
        <text x={342} y={189} textAnchor="end" fontSize="10" className="pl-text pl-soft">
          proposes
        </text>
        <text x={118} y={217} fontSize="10.5" className="pl-text">
          {'{ action: "pay", confidence: 0.81 }'}
        </text>
      </Part>

      {/* 03 Enforce: code's gate, with what it allows and what it refuses. */}
      <Part state={enforce} tone="refused">
        <Wire d={INTO_ENFORCE} />
        <path d="M150 378 V322 A80 40 0 0 1 310 322 V378" className="pl-line" strokeWidth="1.5" />
        <rect x={CX - 5} y={276} width={10} height={12} rx={2} className="pl-box" strokeWidth="1" />
        <text x={CX} y={306} textAnchor="middle" fontSize="10" letterSpacing="1.6" className="pl-text pl-strong">
          CODE
        </text>
        {(["duplicate", "high risk", "payment limit"] as const).map((rule, index) => (
          <g key={rule}>
            <Check x={176} y={326 + index * 17} />
            <text x={192} y={333 + index * 17} fontSize="10" className="pl-text">
              {rule}
            </text>
          </g>
        ))}
        <Wire d={REFUSED} dashed className="pl-refused" />
        <text x={42} y={452} fontSize="9.5" className="pl-text pl-refused-text">
          refused,
        </text>
        <text x={42} y={465} fontSize="9.5" className="pl-text pl-refused-text">
          reason kept
        </text>
      </Part>

      {/* 04 Act: an allowed payment goes to Circle on Arc. */}
      <Part state={act} tone="proof">
        <Wire d={INTO_ACT} />
        <rect x={130} y={414} width={200} height={54} rx={12} className="pl-box" strokeWidth="1.25" />
        <text x={148} y={435} fontSize="10" letterSpacing="1.6" className="pl-text pl-strong">
          CIRCLE · ARC
        </text>
        <rect x={148} y={443} width={74} height={16} rx={4} className="pl-box" strokeWidth="1" />
        <text x={185} y={455} textAnchor="middle" fontSize="9" letterSpacing="1" className="pl-text pl-strong">
          CONFIRMED
        </text>
        <text x={230} y={455} fontSize="10" className="pl-text pl-soft">
          payment intent
        </text>
      </Part>

      {/* 05 Sign: every outcome becomes an entry linked to the one before it, refusals included. */}
      <Part state={sign} tone="proof">
        <Wire d={INTO_SIGN} />
        {ENTRIES.map((entry, index) => {
          const x = entryX(index);
          const newest = index === ENTRIES.length - 1;
          return (
            <g key={entry.seq} className={newest ? "pl-newest" : undefined} data-entry-tone={entry.tone}>
              {index > 0 && <path d={`M${x - ENTRY.gap} ${ENTRY.y + 31} H${x}`} className="pl-line" strokeWidth="1" strokeDasharray="2 2" />}
              <rect x={x} y={ENTRY.y} width={ENTRY.w} height={ENTRY.h} rx={9} className="pl-box pl-entry" strokeWidth="1" />
              <text x={x + 11} y={ENTRY.y + 19} fontSize="10.5" className="pl-text pl-strong">
                #{entry.seq}
              </text>
              <text x={x + 11} y={ENTRY.y + 35} fontSize="9.5" className="pl-text pl-entry-what">
                {entry.what}
              </text>
              <text x={x + 11} y={ENTRY.y + 51} fontSize="9" className="pl-text pl-soft">
                {entry.hash}
              </text>
            </g>
          );
        })}
      </Part>
    </svg>
  );
}
