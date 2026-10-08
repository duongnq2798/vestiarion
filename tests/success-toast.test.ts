import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A decision's confirmation: the action's own words, and for a payment, its transaction one click away, long enough to
 * reach it.
 */

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn() } }));
vi.mock("@/components/ui/Toaster", () => ({ toast: toastMock }));

import { successToast } from "@/components/success-toast";
import { withSuccessToast } from "@/components/withSuccessToast";

beforeEach(() => {
  toastMock.success.mockReset();
});

describe("successToast", () => {
  it("offers the payment's transaction, and stays long enough to open it", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    successToast("Paid 13.50 USDC to Design Studio on Arc testnet.", "https://testnet.arcscan.app/tx/0xab");

    const [message, options] = toastMock.success.mock.calls[0];
    expect(message).toBe("Paid 13.50 USDC to Design Studio on Arc testnet.");
    expect(options).toMatchObject({ duration: 10_000, action: { label: "View transaction" } });
    options.action.onClick();
    expect(open).toHaveBeenCalledWith("https://testnet.arcscan.app/tx/0xab", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("is the words alone with no transaction", () => {
    successToast("Rejected.");
    expect(toastMock.success).toHaveBeenCalledWith("Rejected.");
  });
});

describe("withSuccessToast", () => {
  it("raises the confirmation with the transaction an action returned", async () => {
    const action = withSuccessToast(
      async (): Promise<{ ok: boolean; message: string; txUrl?: string }> => ({ ok: true, message: "Paid 13.50 USDC to Design Studio on Arc testnet.", txUrl: "https://testnet.arcscan.app/tx/0xab" })
    );
    await action({ ok: false, message: "" }, new FormData());
    expect(toastMock.success.mock.calls[0][1]).toMatchObject({ action: { label: "View transaction" } });
  });
});
