/**
 * The treasury arch's geometry (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L5), shared by the
 * drawing (`TreasuryArch`) and the light that runs over its stones while the hero's receipt prints (`ArchLights`).
 */

/** The frame's width in the arch's own units, which is its width in pixels at `xl` (31rem + 2 × 3.5rem). */
export const W = 608;
export const H = 208;
export const CX = W / 2;
/** Where the arch springs from its columns, near the bottom of its drawing. */
export const SPRING = 194;
export const COLUMN = 44;
export const EDGE = 4;
/** The arch's inner and outer half-widths and rises: a flat arch whose opening clears the receipt. */
export const RX_IN = CX - EDGE - COLUMN;
export const RX_OUT = CX - EDGE;
export const RY_IN = 122;
export const RY_OUT = 168;
export const STONES_A_SIDE = 6;
const KEY = 0.13;
const JOINT = 0.012;

function point(rx: number, ry: number, t: number): string {
  return `${(CX + rx * Math.cos(t)).toFixed(1)} ${(SPRING - ry * Math.sin(t)).toFixed(1)}`;
}

/** One stone between two angles of the arch, its faces following the inner and outer curves. */
export function stone(from: number, to: number, inner: [number, number] = [RX_IN, RY_IN], outer: [number, number] = [RX_OUT, RY_OUT]): string {
  const [rxi, ryi] = inner;
  const [rxo, ryo] = outer;
  return `M${point(rxi, ryi, from)} L${point(rxo, ryo, from)} A${rxo} ${ryo} 0 0 1 ${point(rxo, ryo, to)} L${point(rxi, ryi, to)} A${rxi} ${ryi} 0 0 0 ${point(rxi, ryi, from)}Z`;
}

/**
 * The arch's stones in the order a light would climb it: from the left springing up to the keystone, then from the
 * keystone down to the right springing, leaving the keystone's span between the two sides.
 */
export function stones(): Array<{ d: string; tinted: boolean }> {
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

/** The keystone, a little proud of the arch on both faces. */
export const KEYSTONE = stone(Math.PI / 2 + KEY - JOINT, Math.PI / 2 - KEY + JOINT, [RX_IN - 4, RY_IN - 6], [RX_OUT + 6, RY_OUT + 10]);
