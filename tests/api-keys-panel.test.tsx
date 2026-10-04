import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { ApiKeyRow } from "@/lib/platform/api-keys";

/**
 * The API keys section of Settings, as server-rendered markup (the
 * `tests/go-live-panel.test.tsx` shape). Only a hash of a key's secret is
 * stored, so the list cannot offer the full key again; the panel says so
 * rather than leaving a person looking for a copy button.
 */

vi.mock("@/app/actions/api-keys", () => ({
  createApiKeyAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
}));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

const KEY: ApiKeyRow = {
  id: "key-1",
  name: "test-api-key",
  prefix: "c5cka5sg",
  scopes: ["read"],
  createdAt: "2026-09-30T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

describe("ApiKeysPanel", () => {
  it("shows each key's access: read, or read and write (write API R1)", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[KEY, { ...KEY, id: "key-2", name: "billing-sync", scopes: ["read", "write"] }]} canManage />));
    expect(shown).toContain("Access");
    expect(shown).toContain("test-api-key vxk_c5cka5sg_… Read only");
    expect(shown).toContain("billing-sync vxk_c5cka5sg_… Read and write");
  });

  it("tells a manager the full key is shown once and how to replace a lost one", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[KEY]} canManage />));
    expect(shown).toContain("vxk_c5cka5sg_…");
    expect(shown).toContain("A key's full value is shown only once, when it is created.");
    expect(shown).toContain("Create a new key, then revoke the old one.");
  });

  it("points a member without key rights to an owner or admin", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[KEY]} canManage={false} />));
    expect(shown).toContain("Ask an owner or admin for a new key.");
    expect(shown).not.toContain("Create a new key");
  });

  const REVOKED: ApiKeyRow = { ...KEY, id: "key-3", name: "old-sync", prefix: "r3v0k3d0", revokedAt: "2026-10-02T09:00:00.000Z" };

  it("lists the keys that work, and folds revoked ones under them with the day each stopped (Settings structure design S4)", () => {
    const markup = html(<ApiKeysPanel orgSlug="acme" apiKeys={[KEY, REVOKED]} canManage />);
    const [table, fold] = markup.split("<details");
    expect(text(table)).toContain("test-api-key");
    expect(text(table)).not.toContain("old-sync");
    expect(text(fold)).toContain("Revoked keys (1)");
    expect(text(fold)).toContain("old-sync vxk_r3v0k3d0_…");
    expect(text(fold)).toContain("Oct 2, 2026");
    expect(fold).not.toContain("<details open");
    expect(text(markup)).toContain("1 active, 1 revoked");
    // One Revoke, for the one key that can still be revoked.
    expect(text(markup).match(/\bRevoke\b/g)).toHaveLength(1);
  });

  it("counts the keys in the workspace when none is revoked, and shows no fold", () => {
    const markup = html(<ApiKeysPanel orgSlug="acme" apiKeys={[KEY]} canManage />);
    expect(text(markup)).toContain("1 in this workspace");
    expect(markup).not.toContain("<details");
  });

  it("says no key is active when every key was revoked", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[REVOKED]} canManage />));
    expect(shown).toContain("No active keys.");
    expect(shown).toContain("Revoked keys (1)");
    expect(shown).not.toContain("No API keys yet");
  });

  it("says nothing about lost keys when there are none", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[]} canManage />));
    expect(shown).toContain("No API keys yet");
    expect(shown).not.toContain("full value");
  });
});
