import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, giveMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), giveMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/mirror-address", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/mirror-address")>()), giveMirrorAddress: giveMock }));

import { giveMirrorAddressAction } from "@/app/actions/mirror-address";
import MirrorAddressControl from "@/components/MirrorAddressControl";
import { MirrorAddressError } from "@/lib/mirror-address";

/**
 * Giving a payee with no Arc address a mirror address, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-
 * design.md S7): from its row in Counterparties, by someone who may add records, and said in words.
 */

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "u1" } });
  giveMock.mockReset();
});

describe("giveMirrorAddressAction", () => {
  it("is for someone who may add records, and says what it gave", async () => {
    giveMock.mockResolvedValue({ address: "0x6d1a0a0000000000000000000000000000000001", walletId: "w-1" });
    const result = await giveMirrorAddressAction({ ok: false, message: "" }, form({ orgSlug: "northstar", counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de" }));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(giveMock).toHaveBeenCalledWith({ actorId: "u1", counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de" });
    expect(result).toEqual({ ok: true, message: "Mirror address given: 0x6d1a0a0000000000000000000000000000000001. Payments you agree to are made to it." });
  });

  it("says a refusal in its own words, and refuses an id it cannot read", async () => {
    giveMock.mockRejectedValue(new MirrorAddressError("has_address"));
    expect(await giveMirrorAddressAction({ ok: false, message: "" }, form({ orgSlug: "northstar", counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de" }))).toEqual({
      ok: false,
      message: "This payee has an address already. A mirror address is for a payee with none.",
    });
    expect(await giveMirrorAddressAction({ ok: false, message: "" }, form({ orgSlug: "northstar", counterpartyId: "nope" }))).toEqual({ ok: false, message: "That counterparty is not in this workspace." });
  });
});

describe("MirrorAddressControl", () => {
  it("offers a mirror address, and says what it is", () => {
    const markup = renderToStaticMarkup(<MirrorAddressControl orgSlug="northstar" counterparty={{ id: "cp-1", name: "Dien luc" }} />);
    const words = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");
    expect(words).toContain("Give it a mirror address");
    expect(words).toContain("In shadow mode, a payee with no Arc address can be paid at a mirror address: a wallet Vestiarion makes for it on Arc testnet.");
    expect(markup).toContain('name="counterpartyId" value="cp-1"');
  });
});

describe("the Counterparties page and mirror addresses", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/counterparties/page.tsx"), "utf8");

  it("offers one to a payee with no address in shadow mode, and says which addresses are mirrors", () => {
    expect(page).toContain("shadow && canWrite && counterparty.role !== \"client\" && !counterparty.address && (");
    expect(page).toContain("<MirrorAddressControl orgSlug={slug} counterparty={{ id: counterparty.id, name: counterparty.name }} />");
    expect(page).toContain("Mirror address: a wallet Vestiarion made for this payee on Arc testnet, in shadow mode.");
  });
});
