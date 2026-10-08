import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchLightsDrawing, stoneDelay } from "@/components/landing/ArchLights";
import { EvidenceReplay } from "@/components/landing/hero/EvidenceReplay";
import { currentBeat, publishBeat, subscribeBeat } from "@/components/landing/hero/replay-beat";
import { PRINT_AT } from "@/components/landing/hero/scenarios";
import { TreasuryArch } from "@/components/landing/TreasuryArch";

/**
 * The hero, alive under every motion setting (docs/superpowers/specs/2026-10-08-landing-motion-design.md M2): the
 * receipt prints as calm motion, the replays can always be paused, and a light climbs the arch in time with the
 * receipt, ringing the keystone in its outcome.
 */

describe("the arch's lights", () => {
  it("climb the stones while the receipt is observed and reasoned, before it is signed", () => {
    const delays = Array.from({ length: 12 }, (_, index) => stoneDelay(index, 12));
    expect(delays[0]).toBe(PRINT_AT.observe);
    expect(delays.every((delay, index) => index === 0 || delay > delays[index - 1])).toBe(true);
    expect(delays[11]).toBeLessThan(PRINT_AT.sign);
  });

  it("ring the keystone in the outcome, as calm motion, and pause with the replay", () => {
    const playing = renderToStaticMarkup(<ArchLightsDrawing beat={{ run: 3, tone: "refused", playing: true }} />);
    expect(playing).toMatch(/<svg[^>]*class="arch-lights[^"]*"[^>]*data-calm-motion=""[^>]*data-tone="refused"/);
    expect(playing.match(/class="arch-light"/g)).toHaveLength(12);
    expect(playing).toContain(`--d:${PRINT_AT.sign}ms`);
    expect(playing).not.toContain("data-paused");
    const paused = renderToStaticMarkup(<ArchLightsDrawing beat={{ run: 3, tone: "proof", playing: false }} />);
    expect(paused).toContain('data-paused=""');
  });

  it("are not in the server's HTML, which draws the still arch", () => {
    const markup = renderToStaticMarkup(
      <TreasuryArch>
        <p>The receipt</p>
      </TreasuryArch>
    );
    expect(markup).not.toContain("arch-lights");
    expect(markup).toContain("VESTIARION · THE TREASURY");
  });
});

describe("the replay's beat", () => {
  it("tells its listeners of a new beat, once", () => {
    let heard = 0;
    const stop = subscribeBeat(() => {
      heard += 1;
    });
    publishBeat({ run: 41, tone: "proof", playing: true });
    publishBeat({ run: 41, tone: "proof", playing: true });
    publishBeat({ run: 41, tone: "proof", playing: false });
    stop();
    publishBeat({ run: 42, tone: "refused", playing: true });
    expect(heard).toBe(2);
    expect(currentBeat()).toEqual({ run: 42, tone: "refused", playing: true });
  });
});

describe("the hero's receipt", () => {
  const markup = renderToStaticMarkup(<EvidenceReplay head={[]} />);

  it("prints as calm motion", () => {
    expect(markup).toMatch(/<div data-calm-motion="" class="replay"/);
  });

  it("can always be paused", () => {
    expect(markup).toContain('aria-label="Pause the replay"');
  });
});
