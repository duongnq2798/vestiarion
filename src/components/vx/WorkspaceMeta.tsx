import { cn } from "@/components/ui/cn";
import type { OrgRole } from "@/lib/auth/roles";
import { networkProfile, type Network } from "@/lib/network";

export type WorkspaceStanding = "Live" | "Sandbox" | "Not live yet";

/**
 * Whether a workspace moves money. A workspace on Arc mainnet is never a sandbox: it has no simulated money, so until an
 * owner takes it live it is not live yet.
 */
export function workspaceStanding(mode: "sandbox" | "live", network: Network): WorkspaceStanding {
  if (mode === "live") return "Live";
  return network === "arc-mainnet" ? "Not live yet" : "Sandbox";
}

const DOT: Record<WorkspaceStanding, string> = {
  Live: "bg-proof",
  Sandbox: "border border-dashed border-ink-3",
  "Not live yet": "bg-held",
};

/**
 * One item of the line, its separator drawn in its own left padding. The line is shifted left by that padding inside a
 * box that clips, so the separator of whichever item starts a line, the first included, is cut off: a line that wraps
 * in the narrow switcher neither ends nor starts with a dot.
 */
const ITEM = "relative flex items-center gap-1.5 pl-3 before:absolute before:left-0 before:w-3 before:text-center before:content-['·']";

/**
 * Where a workspace stands, as the workspaces page's cards and the switcher show it: live or not, its network from the
 * profile, and the person's role. Arc mainnet, where the money is real, is set apart in the brand colour.
 */
export function WorkspaceMeta({ mode, network, role, className }: { mode: "sandbox" | "live"; network: Network; role: OrgRole; className?: string }) {
  const standing = workspaceStanding(mode, network);
  return (
    <span className={cn("block overflow-hidden text-xs font-normal text-ink-3", className)}>
      <span className="-ml-3 flex flex-wrap items-center gap-y-0.5">
        <span className={ITEM}>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[standing])} />
          <span className={cn(standing === "Live" && "text-proof", standing === "Not live yet" && "text-held")}>{standing}</span>
        </span>
        <span className={cn(ITEM, network === "arc-mainnet" && "font-medium text-agent")}>{networkProfile(network).label}</span>
        <span className={cn(ITEM, "capitalize")}>{role}</span>
      </span>
    </span>
  );
}
