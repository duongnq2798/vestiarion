import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { notifyPayeeAddress } from "@/lib/notifications/payee-address";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * When a payee adds their address through a link, the people who can confirm
 * it are told (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md
 * §2, R4, R7). Best effort: it never throws, and a send that fails is logged.
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/send")>()),
  sendEmail: sendMock,
}));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ADDRESS = "0x2222222222222222222222222222222222222222";

const MEMBERS = [
  { user_id: "u1", email: "owner@studio.test", role: "owner", joined_at: "2026-09-30T00:00:00Z" },
  { user_id: "u2", email: "approver@studio.test", role: "approver", joined_at: "2026-09-30T00:00:00Z" },
  { user_id: "u3", email: "viewer@studio.test", role: "viewer", joined_at: "2026-09-30T00:00:00Z" },
];

function platform<T>(fn: () => Promise<T>, respond: (request: RecordedRequest) => FakeReply) {
  const fake = fakeSupabase(respond);
  return { fake, result: runWith({ config, db: fake.client }, fn) };
}

const workspace = (request: RecordedRequest): FakeReply => {
  if (request.path === "/rest/v1/orgs") return { body: { slug: "mai-studio" } };
  if (request.path === "/rest/v1/rpc/org_members") return { body: MEMBERS };
  return { body: [] };
};

const input = { orgId: ORG, orgName: "Mai Studio", payeeName: "Linh", address: ADDRESS };

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "e1" });
  process.env.SITE_URL = "https://www.vestiarion.xyz";
});

describe("notifyPayeeAddress", () => {
  it("emails each member who can confirm addresses, linking the workspace's Counterparties", async () => {
    const { result } = platform(() => notifyPayeeAddress(input), workspace);
    expect(await result).toBe(2);
    expect(sendMock.mock.calls.map(([message]) => message.to).sort()).toEqual(["approver@studio.test", "owner@studio.test"]);
    const [message] = sendMock.mock.calls[0];
    expect(message.subject).toBe("Linh added an address to be paid at");
    expect(message.text).toContain(ADDRESS);
    expect(message.text).toContain("https://www.vestiarion.xyz/o/mai-studio/counterparties");
  });

  it("counts only the sends that went out, and never throws for one that failed", async () => {
    sendMock.mockResolvedValueOnce({ sent: false, reason: "status 500" }).mockRejectedValueOnce(new Error("network"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = platform(() => notifyPayeeAddress(input), workspace);
    expect(await result).toBe(0);
    logged.mockRestore();
  });

  it("sends nothing, and does not throw, when the workspace cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = platform(() => notifyPayeeAddress(input), () => ({ status: 500, body: { message: "down" } }));
    expect(await result).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
