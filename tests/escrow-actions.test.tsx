import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUpEscrowAction } from "@/app/actions/escrow";
import { EscrowPanel } from "@/components/EscrowPanel";

/**
 * Setting up escrow from Contractors (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E2): an
 * owner's or admin's action in a live workspace, and the panel's three states. The library is stood in for;
 * tests/escrow-setup.test.ts covers it.
 */

const { authorizeMock, lib } = vi.hoisted(() => ({ authorizeMock: vi.fn(), lib: { setUpEscrow: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/circle/escrow-setup", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle/escrow-setup")>()), ...lib }));

import { EscrowSetupError } from "@/lib/circle/escrow-setup";

const ESCROW = "0xE5c0000000000000000000000000000000000E5c";
const access = (mode: "live" | "sandbox") => ({ ok: true, user: { id: "user-1", email: null }, membership: { orgId: "org-1", slug: "testnet-2", name: "Testnet 2", mode, role: "owner" } });
const form = () => {
  const data = new FormData();
  data.set("orgSlug", "testnet-2");
  return data;
};
const empty = { ok: false, message: "" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

beforeEach(() => {
  authorizeMock.mockReset();
  lib.setUpEscrow.mockReset();
});

describe("setUpEscrowAction", () => {
  it("sets up a live workspace's escrow, as an owner or admin", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.setUpEscrow.mockResolvedValue({ address: ESCROW, alreadySetUp: false });
    expect(await setUpEscrowAction(empty, form())).toEqual({ ok: true, message: `Escrow is set up at ${ESCROW}. Lock a milestone in it from its card.` });
    expect(authorizeMock).toHaveBeenCalledWith("testnet-2", "treasury.manage");
    expect(lib.setUpEscrow).toHaveBeenCalledWith({ actorId: "user-1" });
  });

  it("refuses a sandbox, and someone who may not manage treasury", async () => {
    authorizeMock.mockResolvedValue(access("sandbox"));
    expect(await setUpEscrowAction(empty, form())).toEqual({ ok: false, message: "Escrow is a contract on Arc testnet, for a live workspace. Take this workspace live first." });
    authorizeMock.mockResolvedValue({ ok: false, message: "You do not have permission to do that." });
    expect(await setUpEscrowAction(empty, form())).toEqual({ ok: false, message: "You do not have permission to do that." });
    expect(lib.setUpEscrow).not.toHaveBeenCalled();
  });

  it("says what stopped the setup in its own words, and nothing of an unexpected failure", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.setUpEscrow.mockRejectedValueOnce(new EscrowSetupError("The escrow contract is still being deployed. Press Set up escrow again in a minute to finish."));
    expect((await setUpEscrowAction(empty, form())).message).toBe("The escrow contract is still being deployed. Press Set up escrow again in a minute to finish.");
    lib.setUpEscrow.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await setUpEscrowAction(empty, form())).message).toBe("Setting up escrow did not finish. Try again: what was done is kept, and nothing is sent twice.");
  });
});

describe("the escrow panel", () => {
  it("explains escrow and offers to set it up", () => {
    const markup = text(renderToStaticMarkup(<EscrowPanel orgSlug="testnet-2" address={null} deploying={false} canSetUp />));
    expect(markup).toContain("Milestone escrow");
    expect(markup).toContain("Set up escrow");
    expect(markup).toContain("not audited");
  });

  it("offers to finish a setup that was interrupted", () => {
    expect(text(renderToStaticMarkup(<EscrowPanel orgSlug="testnet-2" address={null} deploying canSetUp />))).toContain("Finish setting up");
  });

  it("links the contract once it is set up, and offers nothing to someone who may not set it up", () => {
    const markup = renderToStaticMarkup(<EscrowPanel orgSlug="testnet-2" address={ESCROW} deploying={false} canSetUp={false} />);
    expect(markup).toContain(`href="https://testnet.arcscan.app/address/${ESCROW}"`);
    expect(text(markup)).not.toContain("Set up escrow");
  });
});
