import type { EvidenceTone } from "../evidence/Evidence";

/**
 * Where the hero's receipt is in its replay, for what moves in time with it (docs/superpowers/specs/2026-10-08-
 * landing-motion-design.md M2): the replay publishes a beat each time a receipt starts printing, is paused or comes
 * back on screen, and the arch's lights follow it. A module-level store, read with `useSyncExternalStore`, so the two
 * need not share a parent.
 */
export interface ReplayBeat {
  /** Counts the receipts printed so far: a new one restarts whatever follows it. */
  run: number;
  /** How the receipt being printed ends. */
  tone: EvidenceTone;
  /** False while the replay is paused, or off screen. */
  playing: boolean;
  /** When this receipt started printing, on the page's clock (performance.now()): the first one prints from the first paint, before the script runs. */
  startedAt?: number;
}

let beat: ReplayBeat | null = null;
const listeners = new Set<() => void>();

export function publishBeat(next: ReplayBeat): void {
  if (beat && beat.run === next.run && beat.tone === next.tone && beat.playing === next.playing && beat.startedAt === next.startedAt) return;
  beat = next;
  for (const listener of listeners) listener();
}

export function subscribeBeat(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentBeat(): ReplayBeat | null {
  return beat;
}
