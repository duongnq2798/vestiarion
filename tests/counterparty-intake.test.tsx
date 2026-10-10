import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adding a counterparty: the form says what the payment limit means in plain words, marks Jurisdiction optional as the
 * validation does, and in shadow mode asks whether a supplier sends purchase orders instead of assuming it does. The
 * answer sets the supplier's "Pay without purchase orders" (three-way match design M2); unasked, the default stands.
 */

vi.mock("server-only", () => ({}));

const { authorizeMock, createCounterpartyMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), createCounterpartyMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/workspace-network", () => ({ workspaceNetwork: () => ({ id: "arc-testnet" }) }));
vi.mock("@/lib/counterparties/create", () => ({ createCounterparty: createCounterpartyMock }));

import { createCounterpartyAction } from "@/app/actions/intake";
import CounterpartyIntake, { PURCHASE_ORDERS_QUESTION } from "@/components/intake/CounterpartyIntake";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("CounterpartyIntake", () => {
  it("says what the payment limit means, and marks Jurisdiction optional", () => {
    const page = text(renderToStaticMarkup(<CounterpartyIntake orgSlug="acme" network="arc-testnet" />));
    expect(page).toContain("The agent never pays more than the payment limit on one bill without asking you.");
    expect(page).not.toContain("payment authority");
    expect(page).toContain("Jurisdiction (optional)");
  });

  it("asks whether a supplier sends purchase orders in shadow mode, with no answer chosen, and not otherwise", () => {
    const asked = renderToStaticMarkup(<CounterpartyIntake orgSlug="acme" network="arc-testnet" askPurchaseOrders />);
    expect(text(asked)).toContain("Does this supplier send you purchase orders?");
    const answers = (asked.match(/<button[^>]*role="radio"[^>]*>/g) ?? []).map((tag) => ({ value: /value="([^"]+)"/.exec(tag)?.[1], checked: tag.includes('aria-checked="true"') }));
    expect(answers).toEqual([
      { value: "yes", checked: false },
      { value: "no", checked: false },
    ]);
    expect(asked).toMatch(/role="radiogroup"[^>]*aria-required="true"|aria-required="true"[^>]*role="radiogroup"/);
    expect(text(renderToStaticMarkup(<CounterpartyIntake orgSlug="acme" network="arc-testnet" />))).not.toContain(PURCHASE_ORDERS_QUESTION);
  });
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ orgSlug: "acme", name: "Quill Studio", role: "vendor", chain: "ARC-TESTNET", paymentLimit: "25", ...fields })) data.set(key, value);
  return data;
}

const INITIAL = { ok: false, message: "" };
const passedPurchaseOrders = () => createCounterpartyMock.mock.calls.at(-1)?.[0].purchaseOrderRequired;

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "user-1" }, membership: { orgId: "org-1", role: "owner" } });
  createCounterpartyMock.mockReset().mockResolvedValue({ id: "c-1", name: "Quill Studio", screening: { riskLevel: "clear" } });
});

describe("createCounterpartyAction and purchase orders", () => {
  it("adds a supplier that sends none as paid without purchase orders, and one that does as needing them", async () => {
    expect((await createCounterpartyAction(INITIAL, form({ purchaseOrders: "no" }))).ok).toBe(true);
    expect(passedPurchaseOrders()).toBe(false);
    await createCounterpartyAction(INITIAL, form({ purchaseOrders: "yes" }));
    expect(passedPurchaseOrders()).toBe(true);
  });

  it("leaves the default when the form did not ask, and never sets it on a client", async () => {
    await createCounterpartyAction(INITIAL, form({}));
    expect(passedPurchaseOrders()).toBeUndefined();
    await createCounterpartyAction(INITIAL, form({ purchaseOrders: "maybe" }));
    expect(passedPurchaseOrders()).toBeUndefined();
    await createCounterpartyAction(INITIAL, form({ role: "client", paymentLimit: "", purchaseOrders: "no" }));
    expect(passedPurchaseOrders()).toBeUndefined();
  });
});
