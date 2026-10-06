import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MainnetBanner } from "@/components/MainnetBanner";
import { MAINNET_NOT_LIVE, MAINNET_OFF } from "@/lib/mainnet";

/** What every page of a workspace on Arc mainnet says above its content (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M13). */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("MainnetBanner", () => {
  it("says real USDC moves on a live mainnet workspace", () => {
    expect(text(renderToStaticMarkup(<MainnetBanner mode="live" enabled />))).toContain("Arc mainnet: payments here move real USDC.");
  });

  it("says why nothing moves otherwise", () => {
    expect(text(renderToStaticMarkup(<MainnetBanner mode="sandbox" enabled />))).toContain(MAINNET_NOT_LIVE);
    expect(text(renderToStaticMarkup(<MainnetBanner mode="live" enabled={false} />))).toContain(MAINNET_OFF);
    expect(text(renderToStaticMarkup(<MainnetBanner mode="sandbox" enabled={false} />))).toContain(MAINNET_OFF);
  });
});
