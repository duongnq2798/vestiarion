// @vitest-environment happy-dom
import { redirect } from "next/navigation";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Loading states (docs/superpowers/specs/2026-11-14-loading-states-design.md): when work shows as running and for how
 * long (L2), a button's busy state (L1, L3), the bar while a link is followed (L4), a form whose action never answered
 * (L6), the error screens' retry (L7), and the agent's status line when it cannot be read (L6).
 */

const navigation = vi.hoisted(() => ({ pathname: "/o/acme/invoices", search: "" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { AgentActivity, ACTIVITY_STALE, STALE_AFTER_FAILURES } from "@/components/AgentActivity";
import { BUSY_DELAY_MS, BUSY_MIN_MS, useBusyIndicator } from "@/components/ui/busy";
import { Button } from "@/components/ui/Button";
import { announceNavigation, leavesThePage, NAVIGATION_GIVE_UP_MS, NavigationProgress } from "@/components/ui/NavigationProgress";
import { RetryButton } from "@/components/ui/RetryButton";
import { ACTION_UNANSWERED, answered } from "@/components/ui/useActionForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

function Probe({ active }: { active: boolean }) {
  return <span data-shown={String(useBusyIndicator(active))} />;
}
const shown = () => container.querySelector("[data-shown]")?.getAttribute("data-shown");

describe("when work shows as running (L2)", () => {
  it("shows nothing for work that ends within the delay, so a quick action never blinks", () => {
    act(() => root.render(<Probe active={false} />));
    act(() => root.render(<Probe active />));
    advance(BUSY_DELAY_MS - 50);
    expect(shown()).toBe("false");
    act(() => root.render(<Probe active={false} />));
    advance(BUSY_MIN_MS);
    expect(shown()).toBe("false");
  });

  it("shows work that runs past the delay, and keeps it shown for the minimum once it ends", () => {
    act(() => root.render(<Probe active={false} />));
    act(() => root.render(<Probe active />));
    advance(BUSY_DELAY_MS);
    expect(shown()).toBe("true");
    advance(50);
    act(() => root.render(<Probe active={false} />));
    advance(BUSY_MIN_MS - 100);
    expect(shown()).toBe("true");
    advance(100);
    expect(shown()).toBe("false");
  });

  it("shows work already running on the first render at once", () => {
    act(() => root.render(<Probe active />));
    expect(shown()).toBe("true");
  });
});

function Toggle() {
  const [loading, setLoading] = useState(false);
  return (
    <>
      <Button loading={loading} icon={<svg data-icon="" />}>
        Save
      </Button>
      <button data-toggle="" onClick={() => setLoading((was) => !was)} />
    </>
  );
}

describe("a busy button (L1, L3)", () => {
  const save = () => container.querySelector<HTMLButtonElement>("button")!;
  const toggle = () => act(() => container.querySelector<HTMLButtonElement>("[data-toggle]")!.click());

  it("is disabled and busy at once, and swaps its icon for a spinner only after the delay", () => {
    act(() => root.render(<Toggle />));
    toggle();
    expect(save().disabled).toBe(true);
    expect(save().getAttribute("aria-busy")).toBe("true");
    expect(save().querySelector("[data-icon]")).not.toBeNull();
    advance(BUSY_DELAY_MS);
    expect(save().querySelector("[data-icon]")).toBeNull();
    expect(save().querySelector(".animate-spin")).not.toBeNull();
    expect(save().textContent).toContain("Save");
  });

  it("keeps the colour it had while busy, so a quick action shows no change at all", () => {
    expect(renderToStaticMarkup(<Button loading>Save</Button>)).toContain("aria-busy:disabled:opacity-100");
  });

  it("holds its width while busy and lets go once the spinner has gone", () => {
    act(() => root.render(<Toggle />));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 96 } as DOMRect);
    toggle();
    expect(save().style.minWidth).toBe("96px");
    advance(BUSY_DELAY_MS);
    toggle();
    expect(save().style.minWidth).toBe("96px");
    advance(BUSY_MIN_MS);
    expect(save().style.minWidth).toBe("");
  });

  it("stays plain markup with no client part when it can never be busy", () => {
    const markup = renderToStaticMarkup(<Button icon={<svg data-icon="" />}>Open</Button>);
    expect(markup).not.toContain("<span hidden");
    expect(markup).not.toContain('aria-busy="');
  });
});

describe("the bar while a link is followed (L4)", () => {
  const here = new URL("https://www.vestiarion.xyz/o/acme/invoices?tab=open");
  const linkClick = (href: string, init: MouseEventInit = {}, attributes: Record<string, string> = {}) => {
    const link = document.createElement("a");
    link.href = href;
    for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
    const inside = document.createElement("span");
    link.appendChild(inside);
    document.body.appendChild(link);
    const event = new MouseEvent("click", { bubbles: true, button: 0, ...init });
    Object.defineProperty(event, "target", { value: inside });
    link.remove();
    return event;
  };

  it("counts a plain click on a link to another page of this site, query included", () => {
    expect(leavesThePage(linkClick("/o/acme/approvals"), here)).toBe("/o/acme/approvals");
    expect(leavesThePage(linkClick("/o/acme/invoices?tab=paid"), here)).toBe("/o/acme/invoices?tab=paid");
  });

  it("leaves out a new tab, a modifier, a download, another site, and the page itself or a place in it", () => {
    expect(leavesThePage(linkClick("/o/acme/approvals", {}, { target: "_blank" }), here)).toBeNull();
    expect(leavesThePage(linkClick("/o/acme/approvals", { metaKey: true }), here)).toBeNull();
    expect(leavesThePage(linkClick("/o/acme/approvals", { button: 1 }), here)).toBeNull();
    expect(leavesThePage(linkClick("/o/acme/audit.csv", {}, { download: "" }), here)).toBeNull();
    expect(leavesThePage(linkClick("https://explorer.arc.io/tx/0x1"), here)).toBeNull();
    expect(leavesThePage(linkClick("/o/acme/invoices?tab=open#bill-4"), here)).toBeNull();
  });

  const bar = () => container.querySelector("[data-navigation]")?.getAttribute("data-navigation");

  it("shows only once the next page takes longer than a moment, then fills and fades when it lands", () => {
    navigation.pathname = "/o/acme/invoices";
    navigation.search = "";
    window.history.replaceState(null, "", "/o/acme/invoices");
    act(() => root.render(<NavigationProgress />));
    expect(bar()).toBe("idle");
    const link = document.createElement("a");
    link.href = "/o/acme/approvals";
    container.appendChild(link);
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })));
    expect(bar()).toBe("idle");
    advance(BUSY_DELAY_MS);
    expect(bar()).toBe("running");
    navigation.pathname = "/o/acme/approvals";
    act(() => root.render(<NavigationProgress />));
    expect(bar()).toBe("done");
    advance(BUSY_MIN_MS);
    expect(bar()).toBe("idle");
  });

  it("shows for a navigation started from code, and gives up on one that never lands", () => {
    navigation.pathname = "/o/acme/invoices";
    navigation.search = "sort=due";
    window.history.replaceState(null, "", "/o/acme/invoices?sort=due");
    act(() => root.render(<NavigationProgress />));
    act(() => announceNavigation());
    advance(BUSY_DELAY_MS);
    expect(bar()).toBe("running");
    advance(NAVIGATION_GIVE_UP_MS);
    advance(BUSY_MIN_MS);
    expect(bar()).toBe("idle");
  });
});

describe("a form whose action never answered (L6)", () => {
  const before = { ok: true, message: "", fieldErrors: { name: "kept" } };

  it("refuses with a message that sends the person to check, keeping the rest of its state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await answered(async () => Promise.reject(new TypeError("Failed to fetch")), before, new FormData());
    expect(result).toEqual({ ok: false, message: ACTION_UNANSWERED, fieldErrors: { name: "kept" } });
  });

  it("passes the action's own result through, refusals included", async () => {
    const refused = { ok: false, message: "Choose a counterparty.", fieldErrors: {} };
    expect(await answered(async () => refused, before, new FormData())).toBe(refused);
  });

  it("lets a redirect from the action go on to Next", async () => {
    await expect(answered(async () => redirect("/o/acme/approvals"), before, new FormData())).rejects.toThrow();
  });
});

describe("an error screen's retry (L7)", () => {
  it("asks for the part again, as a button that can show it is busy", () => {
    const retry = vi.fn();
    act(() => root.render(<RetryButton retry={retry} />));
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Try again");
    act(() => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("the agent's status line when it cannot be read (L6)", () => {
  it("says it is not updating after a few misses in a row, and keeps asking", async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const fetches = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => root.render(<AgentActivity lastCycleAt="2026-11-14T08:00:00Z" />));
    for (let miss = 0; miss < STALE_AFTER_FAILURES; miss += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
    }
    expect(fetches.mock.calls.length).toBeGreaterThanOrEqual(STALE_AFTER_FAILURES);
    expect(container.textContent).toContain(ACTIVITY_STALE);
    for (const [, init] of fetches.mock.calls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("drops the note once a read answers again", async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const fetches = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    act(() => root.render(<AgentActivity lastCycleAt={null} />));
    for (let miss = 0; miss < STALE_AFTER_FAILURES; miss += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
    }
    expect(container.textContent).toContain(ACTIVITY_STALE);
    fetches.mockResolvedValue(new Response(JSON.stringify({ running: null, head: 1, lastCycleAt: null, items: [] })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(container.textContent).not.toContain(ACTIVITY_STALE);
  });
});
