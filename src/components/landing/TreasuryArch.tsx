import type { ReactNode } from "react";

/**
 * The vestiarion, drawn around what it guards (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L5): the
 * treasury's gate, whose stones are ledger entries. Two columns of entries linked by their hashes hold up a flat arch,
 * and its keystone carries the mark. It frames the hero's decision receipt on a wide screen and is decoration only:
 * hidden from assistive technology, and absent below the `xl` breakpoint, where the hero has no room for the columns.
 */

/** The frame's width in the arch's own units, which is its width in pixels at `xl` (31rem + 2 × 3.5rem). */
const W = 608;
const H = 208;
const CX = W / 2;
/** Where the arch springs from its columns, near the bottom of its drawing. */
const SPRING = 194;
const COLUMN = 44;
const EDGE = 4;
/** The arch's inner and outer half-widths and rises: a flat arch whose opening clears the receipt. */
const RX_IN = CX - EDGE - COLUMN;
const RX_OUT = CX - EDGE;
const RY_IN = 122;
const RY_OUT = 168;
const STONES_A_SIDE = 6;
const KEY = 0.13;
const JOINT = 0.012;

/** Short, plausible hashes for the stones: drawn, not read from any ledger. */
const HASHES = ["7b1e", "c21e", "9f04", "e3a7", "41dd", "b82c", "05f9", "d6e1", "a3c0", "6e2b", "f7a9", "2c58", "8d13", "3fa6"];

function point(rx: number, ry: number, t: number): string {
  return `${(CX + rx * Math.cos(t)).toFixed(1)} ${(SPRING - ry * Math.sin(t)).toFixed(1)}`;
}

/** One stone between two angles of the arch, its faces following the inner and outer curves. */
function stone(from: number, to: number, inner: [number, number] = [RX_IN, RY_IN], outer: [number, number] = [RX_OUT, RY_OUT]): string {
  const [rxi, ryi] = inner;
  const [rxo, ryo] = outer;
  return `M${point(rxi, ryi, from)} L${point(rxo, ryo, from)} A${rxo} ${ryo} 0 0 1 ${point(rxo, ryo, to)} L${point(rxi, ryi, to)} A${rxi} ${ryi} 0 0 0 ${point(rxi, ryi, from)}Z`;
}

/** The arch's stones from the left springing over to the right, leaving the keystone's span between them. */
function stones(): Array<{ d: string; tinted: boolean }> {
  const half = Math.PI / 2;
  const span = (half - KEY) / STONES_A_SIDE;
  const drawn: Array<{ d: string; tinted: boolean }> = [];
  for (const start of [Math.PI, half - KEY]) {
    for (let index = 0; index < STONES_A_SIDE; index += 1) {
      drawn.push({ d: stone(start - index * span - JOINT, start - (index + 1) * span + JOINT), tinted: index % 2 === 1 });
    }
  }
  return drawn;
}

function Arch() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-x-0 top-0 w-full overflow-visible">
      {stones().map((piece, index) => (
        <path key={index} d={piece.d} className={piece.tinted ? "fill-agent-soft stroke-agent-line" : "fill-surface stroke-line-strong"} strokeWidth="1" />
      ))}
      <path d={stone(Math.PI / 2 + KEY - JOINT, Math.PI / 2 - KEY + JOINT, [RX_IN - 4, RY_IN - 6], [RX_OUT + 6, RY_OUT + 10])} className="fill-agent stroke-agent" strokeWidth="1" />
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
        <Column side="left" offset={0} />
        <Column side="right" offset={9} />
        <span className="absolute inset-x-0 bottom-[44px] h-px bg-line-strong" />
        <span className="absolute inset-x-0 bottom-3 text-center font-mono text-[10px] tracking-[0.42em] text-ink-3">VESTIARION · THE TREASURY</span>
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}
