import type { ReactNode } from "react";
import { ArchLights } from "./ArchLights";
import { COLUMN, CX, EDGE, H, KEYSTONE, RY_OUT, SPRING, W, stones } from "./arch-geometry";

/**
 * The vestiarion, drawn around what it guards (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L5): the
 * treasury's gate, whose stones are ledger entries. Two columns of entries linked by their hashes hold up a flat arch,
 * and its keystone carries the mark. It frames the hero's decision receipt on a wide screen and is decoration only:
 * hidden from assistive technology, and absent below the `xl` breakpoint, where the hero has no room for the columns.
 */

/** Short, plausible hashes for the stones: drawn, not read from any ledger. */
const HASHES = ["7b1e", "c21e", "9f04", "e3a7", "41dd", "b82c", "05f9", "d6e1", "a3c0", "6e2b", "f7a9", "2c58", "8d13", "3fa6"];

function Arch() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-x-0 top-0 w-full overflow-visible">
      {stones().map((piece, index) => (
        <path key={index} d={piece.d} className={piece.tinted ? "fill-agent-soft stroke-agent-line" : "fill-surface stroke-line-strong"} strokeWidth="1" />
      ))}
      <path d={KEYSTONE} className="fill-agent stroke-agent" strokeWidth="1" />
      <path
        d={`M${CX - 10} ${SPRING - RY_OUT + 12} L${CX} ${SPRING - RY_OUT + 30} L${CX + 10} ${SPRING - RY_OUT + 12}`}
        fill="none"
        className="stroke-on-agent"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The capitals the arch springs from. */}
      <rect x={EDGE - 6} y={SPRING} width={COLUMN + 12} height="12" rx="3" className="fill-surface stroke-line-strong" strokeWidth="1" />
      <rect x={W - EDGE - COLUMN - 6} y={SPRING} width={COLUMN + 12} height="12" rx="3" className="fill-surface stroke-line-strong" strokeWidth="1" />
    </svg>
  );
}

/** A column of ledger entries, each naming the hash of the one below it; it grows with the receipt it flanks. */
function Column({ side, offset }: { side: "left" | "right"; offset: number }) {
  return (
    <div
      className="absolute flex flex-col-reverse gap-[3px]"
      style={{ [side]: EDGE, width: COLUMN, top: H + 2, bottom: 46 }}
    >
      <span className="absolute inset-y-1 left-1/2 w-px border-l border-dashed border-agent/50" />
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className="relative flex min-h-0 flex-1 flex-col justify-center rounded-md border border-line-strong bg-surface px-1.5 font-mono text-[8px] leading-[1.35] tracking-[0.02em]">
          <span className="text-ink-3">#{1915 + offset + index}</span>
          <span className="text-ink-2">{HASHES[(offset + index) % HASHES.length]}…</span>
          <span className="absolute -top-[3px] right-1.5 size-[5px] rounded-full bg-agent/70" />
        </span>
      ))}
    </div>
  );
}

/** The receipt in its arch on a wide screen; the receipt alone below `xl`. */
export function TreasuryArch({ children }: { children: ReactNode }) {
  return (
    <div className="relative xl:-mx-14 xl:px-14 xl:pb-16 xl:pt-36">
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden select-none xl:block">
        <Arch />
        <ArchLights />
        <Column side="left" offset={0} />
        <Column side="right" offset={9} />
        <span className="absolute inset-x-0 bottom-[44px] h-px bg-line-strong" />
        <span className="absolute inset-x-0 bottom-3 text-center font-mono text-[10px] tracking-[0.42em] text-ink-3">VESTIARION · THE TREASURY</span>
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}
