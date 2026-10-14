import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { AsanaProvider } from "@/lib/asana/provider";
import type { AsanaSession } from "@/lib/asana/session";
import type { TaskLink } from "@/lib/asana/links";
import type { Connection } from "@/lib/connectors/connections";
import { startWebhook } from "@/lib/asana/workspace";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Making a linked task's webhook (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11): Asana's answer to
 * the request that made it carries the secret its handshake sent (a top-level `X-Hook-Secret` in the 201's body, as
 * Asana documents it), and the webhook is kept only when that is the secret the handshake left here. Anything else,
 * no secret at all included, is not Asana's handshake: the webhook is deleted at Asana and here.
 */

const { store } = vi.hoisted(() => ({
  store: {
    kept: null as string | null,
    newWebhook: vi.fn(async () => "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a1"),
    activateWebhook: vi.fn(async () => true),
    markWebhookDeleted: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/asana/webhook-store", async (original) => ({
  ...(await original<typeof import("@/lib/asana/webhook-store")>()),
  newWebhook: store.newWebhook,
  activateWebhook: store.activateWebhook,
  markWebhookDeleted: store.markWebhookDeleted,
  webhookSecret: async () => store.kept,
}));

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-0000000a5a77";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const KEPT = "2b9f0c7e5d4a3b2c1d0e9f8a7b6c5d4e";

function context(answer: { gid: string; secret: string | null }) {
  const createWebhook = vi.fn(async () => answer);
  const deleteWebhook = vi.fn(async () => true);
  const session: AsanaSession = { call: (read) => read("access") };
  const provider = { reader: { createWebhook, deleteWebhook } } as unknown as AsanaProvider;
  return { ctx: { connection: { id: "conn-asana" } as Connection, provider, session }, createWebhook, deleteWebhook };
}

const link = { id: "link-1", taskGid: "1219477646404728" } as TaskLink;
const start = (ctx: ReturnType<typeof context>["ctx"]) =>
  runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), () => startWebhook(link, ctx, "https://www.vestiarion.xyz"));

beforeEach(() => {
  store.kept = KEPT;
  store.activateWebhook.mockClear();
  store.markWebhookDeleted.mockClear();
});

describe("startWebhook", () => {
  it("keeps a webhook whose answer carries the secret the handshake left", async () => {
    const made = context({ gid: "8800001", secret: KEPT });
    expect(await start(made.ctx)).toBe(true);
    expect(made.createWebhook).toHaveBeenCalledWith("access", { resource: link.taskGid, target: "https://www.vestiarion.xyz/api/integrations/asana/webhook/5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a1" });
    expect(store.activateWebhook).toHaveBeenCalledTimes(1);
    expect(made.deleteWebhook).not.toHaveBeenCalled();
  });

  it("deletes one whose answer carries another secret, or none", async () => {
    for (const secret of ["another-secret-from-someone-else", null]) {
      const made = context({ gid: "8800002", secret });
      expect(await start(made.ctx)).toBe(false);
      expect(made.deleteWebhook).toHaveBeenCalledWith("access", "8800002");
    }
    expect(store.activateWebhook).not.toHaveBeenCalled();
    expect(store.markWebhookDeleted).toHaveBeenCalledTimes(2);
  });

  it("deletes one whose handshake never came", async () => {
    store.kept = null;
    const made = context({ gid: "8800003", secret: KEPT });
    expect(await start(made.ctx)).toBe(false);
    expect(made.deleteWebhook).toHaveBeenCalledWith("access", "8800003");
  });
});
