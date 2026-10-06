import { Callout } from "@/components/ui/Callout";
import { MAINNET_NOT_LIVE, MAINNET_OFF } from "@/lib/mainnet";

/**
 * What every page of a workspace on Arc mainnet says above its content (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md
 * M13): that its payments move real USDC, or why nothing moves yet. Drawn by the workspace layout from platform data
 * only, its membership and the deployment's switch, so it reads no tenant rows.
 */
export function MainnetBanner({ mode, enabled }: { mode: "sandbox" | "live"; enabled: boolean }) {
  const held = !enabled ? MAINNET_OFF : mode !== "live" ? MAINNET_NOT_LIVE : null;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      {held ? (
        <Callout tone="held" title="Arc mainnet">
          {held}
        </Callout>
      ) : (
        <Callout tone="proof" title="Arc mainnet">
          Arc mainnet: payments here move real USDC.
        </Callout>
      )}
    </div>
  );
}
