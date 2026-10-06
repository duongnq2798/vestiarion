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
 * Where a workspace stands, as the workspaces page's cards and the switcher show it: live or not, its network from the
 * profile, and the person's role. Arc mainnet, where the money is real, is set apart in the brand colour.
 */
export function WorkspaceMeta({ mode, network, role, className }: { mode: "sandbox" | "live"; network: Network; role: OrgRole; className?: string }) {
  const standing = workspaceStanding(mode, network);
  return (
    <span className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-normal text-ink-3", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[standing])} />
      <span className={cn(standing === "Live" && "text-proof", standing === "Not live yet" && "text-held")}>{standing}</span>
      <span aria-hidden>·</span>
      <span className={cn(network === "arc-mainnet" && "font-medium text-agent")}>{networkProfile(network).label}</span>
      <span aria-hidden>·</span>
      <span className="capitalize">{role}</span>
    </span>
  );
}
