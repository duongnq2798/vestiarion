import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/github", () => ({ disconnectGitHubAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import GitHubPanel, { GITHUB_NOTICES } from "@/components/GitHubPanel";

/** The Settings section for GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G2, G3), for each role. */
describe("GitHubPanel", () => {
  const acme = { installationId: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected" as const, connectedAt: "2026-10-04T08:00:00Z" };

  it("offers Connect GitHub to an owner or admin, through the install route, and says what it does", () => {
    const markup = renderToStaticMarkup(<GitHubPanel orgSlug="acme" installations={[]} canManage notice={null} network="arc-testnet" />);
    expect(markup).toContain('href="/api/github/install?org=acme"');
    expect(markup).toContain("Connect GitHub");
    expect(markup).toContain("gets a comment on that pull request");
  });

  it("tells anyone else who may connect it, and offers them nothing", () => {
    const markup = renderToStaticMarkup(<GitHubPanel orgSlug="acme" installations={[acme]} canManage={false} notice={null} network="arc-testnet" />);
    expect(markup).not.toContain("/api/github/install");
    expect(markup).not.toContain("Disconnect");
    expect(markup).toContain("An owner or admin connects GitHub.");
    expect(markup).toContain("acme");
  });

  it("lists each connected account, what it covers, and lets a manager disconnect it or connect another", () => {
    const markup = renderToStaticMarkup(
      <GitHubPanel orgSlug="acme" installations={[acme, { ...acme, installationId: 43, accountLogin: "mona", accountType: "User", repositorySelection: "all" }]} canManage notice={null} network="arc-testnet" />
    );
    expect(markup).toContain("acme");
    expect(markup).toContain("selected repositories");
    expect(markup).toContain("mona");
    expect(markup).toContain("all repositories");
    expect(markup.match(/Disconnect/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain('name="installationId" value="42"');
    expect(markup).toContain("Connect another account");
    expect(markup).toContain("uninstall it on GitHub");
  });

  it("says how connecting went, by the code in ?github=, and nothing for a code it does not know", () => {
    for (const [code, notice] of Object.entries(GITHUB_NOTICES)) {
      const markup = renderToStaticMarkup(<GitHubPanel orgSlug="acme" installations={[]} canManage notice={code} network="arc-testnet" />);
      expect(markup).toContain(notice.text.replaceAll("'", "&#x27;"));
    }
    expect(Object.keys(GITHUB_NOTICES).sort()).toEqual(["cancelled", "connected", "failed", "forbidden", "not_yours", "requested"]);
    expect(renderToStaticMarkup(<GitHubPanel orgSlug="acme" installations={[]} canManage notice="<script>" network="arc-testnet" />)).not.toContain("<script>");
  });
});
