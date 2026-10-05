import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PayeeAddressForm from "@/components/PayeeAddressForm";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import { PASSKEY_OPTION } from "@/components/payee/PasskeyWalletOption";
import { PasskeyWallet } from "@/components/wallet/PasskeyWallet";
import type { PayeeLinkStatus } from "@/lib/payee-journey";
import { ARC_TESTNET } from "@/lib/network";

/**
 * The passkey wallet beside a payee link's address (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md
 * P1, P3, P4, P6), as the markup the pages render on the server. The router and the server action are stand-ins.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/payee/[token]/actions", () => ({ submitPayeeAddressAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(node);

const status = (over: Partial<PayeeLinkStatus> = {}): PayeeLinkStatus => ({
  orgName: "Northstar",
  payeeName: "Lena Ortiz",
  chain: ARC_TESTNET.circleBlockchain,
  linkState: "open",
  expiresAt: "2026-10-12T00:00:00Z",
  usedAt: null,
  statusUntil: "2026-10-12T00:00:00Z",
  address: null,
  addressConfirmed: false,
  payments: [],
  ...over,
});

const configured = () => {
  vi.stubEnv("NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_KEY", "TEST_CLIENT_KEY:abc");
  vi.stubEnv("NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL", "https://modular-sdk.circle.com/v1/rpc/w3s/buidl");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the payee link's address step (P1)", () => {
  it("keeps the address and Continue as the page's one primary action, with the passkey wallet as a secondary button beneath", () => {
    const markup = html(<PayeeAddressForm token="t" orgName="Northstar" passkey={{ payeeName: "Lena Ortiz" }} />);
    expect(markup).toContain("Your wallet address on Arc testnet");
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*Continue<\/button>/);
    expect(markup).toContain(PASSKEY_OPTION);
    expect(markup.indexOf(PASSKEY_OPTION)).toBeGreaterThan(markup.indexOf("Continue"));
    // Secondary: not a submit, and not the primary style.
    expect(markup).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>(?:(?!</button>).)*${PASSKEY_OPTION.replace(/[?]/g, "\\?")}`));
  });

  it("shows no passkey option unless offered", () => {
    expect(html(<PayeeAddressForm token="t" orgName="Northstar" />)).not.toContain(PASSKEY_OPTION);
  });

  it("offers it to a payee paid on Arc testnet when the Modular Wallets client key and URL are set (P6)", () => {
    configured();
    expect(html(<PayeeJourney token="t" status={status()} refresh={false} />)).toContain(PASSKEY_OPTION);
    expect(html(<PayeeJourney token="t" status={status({ chain: "ARB-SEPOLIA" })} refresh={false} />)).not.toContain(PASSKEY_OPTION);
  });

  it("offers nothing when they are not set", () => {
    expect(html(<PayeeJourney token="t" status={status()} refresh={false} />)).not.toContain(PASSKEY_OPTION);
  });
});

describe("the wallet page (P4, P6)", () => {
  it("says passkey wallets are not available when the client key and URL are not set", () => {
    const markup = html(<PasskeyWallet configured={false} />);
    expect(markup).toContain("Passkey wallets are not available here yet.");
    expect(markup).not.toContain("Open my wallet");
  });

  it("opens with the passkey the wallet was created with", () => {
    const markup = html(<PasskeyWallet configured />);
    expect(markup).toContain("Your Vestiarion wallet");
    expect(markup).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Open my wallet<\/button>/);
  });
});
