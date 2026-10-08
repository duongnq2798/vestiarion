"use client";

import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { H, KEYSTONE, W, stones } from "./arch-geometry";
import { PRINT_AT } from "./hero/scenarios";
import { currentBeat, subscribeBeat, type ReplayBeat } from "./hero/replay-beat";

/** When the light reaches each stone: it climbs the arch while the receipt is observed and reasoned, and is over it by the time it is signed. */
export function stoneDelay(index: number, count: number): number {
  return Math.round(PRINT_AT.observe + (index * (PRINT_AT.sign - PRINT_AT.observe)) / count);
}

/**
 * The light that climbs the treasury's arch while the hero's receipt prints (docs/superpowers/specs/2026-10-08-
 * landing-motion-design.md M2): stone by stone from the left springing over to the right, then the keystone rings in
 * the receipt's outcome when it is signed, jade for a payment, vermilion for a refusal. A new receipt starts it again,
 * and it pauses with the replay. It changes only opacity and colour, so it runs under reduced motion too
 * (`data-calm-motion`). Nothing before the replay's first beat, so the server's HTML is the still arch.
 */
export function ArchLights() {
  const beat = useSyncExternalStore(subscribeBeat, currentBeat, () => null);
  return beat ? <ArchLightsDrawing key={beat.run} beat={beat} /> : null;
}

/**
 * One receipt's light. It is drawn when the receipt has already been printing a while (the first one prints from the
 * first paint, before the script runs), so every delay is moved back by that much, once, when it is drawn.
 */
export function ArchLightsDrawing({ beat }: { beat: ReplayBeat }) {
  const [behind] = useState(() => (beat.startedAt === undefined ? 0 : Math.max(0, Math.round(performance.now() - beat.startedAt))));
  const pieces = stones();
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="arch-lights absolute inset-x-0 top-0 w-full overflow-visible"
      data-calm-motion=""
      data-tone={beat.tone}
      data-paused={beat.playing ? undefined : ""}
    >
      {pieces.map((piece, index) => (
        <path key={index} d={piece.d} className="arch-light" style={{ "--d": `${stoneDelay(index, pieces.length) - behind}ms` } as CSSProperties} />
      ))}
      <path d={KEYSTONE} className="arch-key-light" strokeWidth="3" style={{ "--d": `${PRINT_AT.sign - behind}ms` } as CSSProperties} />
    </svg>
  );
}
