import { Callout } from "@/components/ui/Callout";
import { networkHold } from "@/lib/mainnet";

/**
 * What every page of a workspace on Arc mainnet says above its content (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md
 * M13): that its payments move real USDC, or why nothing moves yet. Read by the workspace layout from platform data
 * only, its membership and the deployment's switch, so it reads no tenant rows; drawn under the page's header.
 */
export function MainnetBanner({ mode, enabled }: { mode: "sandbox" | "live"; enabled: boolean }) {
  // The same rule every gate reads (mainnet limits L7), so the banner and the gates never disagree.
  const held = networkHold("arc-mainnet", mode, { mainnetEnabled: enabled });
  return held ? (
    <Callout tone="held" title="Arc mainnet">
      {held}
    </Callout>
  ) : (
    <Callout tone="proof" title="Arc mainnet">
      Arc mainnet: payments here move real USDC.
    </Callout>
  );
}
