import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));

import { membershipsOf } from "@/lib/auth/membership";

/** A membership names its workspace's network (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M13). */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("membershipsOf", () => {
  it("reads each workspace's network, a row from before 0075 as Arc testnet", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/memberships"
        ? {
            body: [
              { role: "owner", orgs: { id: "o-1", slug: "acme-main", name: "Acme Mainnet", mode: "sandbox", network: "arc-mainnet" } },
              { role: "owner", orgs: { id: "o-2", slug: "acme", name: "Acme", mode: "live", network: "arc-testnet" } },
              { role: "viewer", orgs: { id: "o-3", slug: "old", name: "Old", mode: "live" } },
            ],
          }
        : { body: [] }
    );
    const memberships = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => membershipsOf("user-network-1"));
    expect(memberships.map((membership) => [membership.slug, membership.network])).toEqual([
      ["acme", "arc-testnet"],
      ["acme-main", "arc-mainnet"],
      ["old", "arc-testnet"],
    ]);
    expect(fake.requests[0].params.get("select")).toBe("role,orgs!inner(id,slug,name,mode,network)");
  });
});
