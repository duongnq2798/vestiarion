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

  it("says nothing about lost keys when there are none", () => {
    const shown = text(html(<ApiKeysPanel orgSlug="acme" apiKeys={[]} canManage />));
    expect(shown).toContain("No API keys yet");
    expect(shown).not.toContain("full value");
  });
});
