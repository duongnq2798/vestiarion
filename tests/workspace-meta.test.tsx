import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceMeta, workspaceStanding } from "@/components/vx/WorkspaceMeta";

/**
 * Where a workspace stands, on the workspaces page's cards and in the switcher: live or not, on which network, and the
 * person's role, so Arc testnet and Arc mainnet workspaces are told apart before one is opened. A workspace on Arc
 * mainnet is never a sandbox: it has no simulated money, so until an owner takes it live it is "Not live yet".
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("workspaceStanding", () => {
  it.each([
    ["live", "arc-testnet", "Live"],
    ["sandbox", "arc-testnet", "Sandbox"],
    ["live", "arc-mainnet", "Live"],
    ["sandbox", "arc-mainnet", "Not live yet"],
  ] as const)("calls a %s workspace on %s %j", (mode, network, standing) => {
    expect(workspaceStanding(mode, network)).toBe(standing);
  });
});

describe("WorkspaceMeta", () => {
  it("names the standing, the network from its profile, and the role", () => {
    expect(text(renderToStaticMarkup(<WorkspaceMeta mode="sandbox" network="arc-testnet" role="owner" />))).toBe("Sandbox Arc testnet owner");
    expect(text(renderToStaticMarkup(<WorkspaceMeta mode="live" network="arc-testnet" role="admin" />))).toBe("Live Arc testnet admin");
    expect(text(renderToStaticMarkup(<WorkspaceMeta mode="sandbox" network="arc-mainnet" role="owner" />))).toBe("Not live yet Arc mainnet owner");
  });

  it("draws each separator before its item, clipped at a line's start, so a wrapped line never ends or starts with one", () => {
    // In the switcher the line wraps: a "·" written as text stayed at the end of the first line.
    const markup = renderToStaticMarkup(<WorkspaceMeta mode="live" network="arc-testnet" role="owner" />);
    expect(text(markup)).not.toContain("·");
    // React escapes the quotes inside the class attribute.
    expect(markup.match(/before:content-\[(?:'|&#x27;)·(?:'|&#x27;)\]/g)).toHaveLength(3);
    expect(markup).toMatch(/^<span class="[^"]*overflow-hidden[^"]*"><span class="[^"]*-ml-3[^"]*flex-wrap/);
  });

  it("sets Arc mainnet apart in the brand colour, and Arc testnet not", () => {
    expect(renderToStaticMarkup(<WorkspaceMeta mode="live" network="arc-mainnet" role="owner" />)).toMatch(/class="[^"]*text-agent[^"]*">Arc mainnet</);
    expect(renderToStaticMarkup(<WorkspaceMeta mode="live" network="arc-testnet" role="owner" />)).not.toContain("text-agent");
  });

  it("is what the workspaces page's cards and the switcher both show", () => {
    expect(source("src/app/onboarding/page.tsx")).toContain("<WorkspaceMeta mode={membership.mode} network={membership.network} role={membership.role}");
    expect(source("src/components/vx/AppNav.tsx")).toContain("<WorkspaceMeta mode={workspace.mode} network={workspace.network} role={workspace.role}");
  });
});
