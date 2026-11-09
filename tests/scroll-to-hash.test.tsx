// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A link to a part of a workspace page opens that part, a folded row included, and not only when the page first mounts
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL15, C8). Found in review: a console toast for a held
 * milestone, clicked with Contractors already open, pushed `/contractors#milestone-<id>`. Only the fragment changed, so
 * nothing mounted again and the row stayed folded, its Pay now and Close without paying hidden inside it. Rendered in a
 * DOM, with the router stood in for: Next.js scrolls to the fragment itself, and nothing in it opens a `<details>`.
 */

const nav = vi.hoisted(() => ({
  query: "",
  router: { push: (() => undefined) as (href: string) => void, refresh: () => undefined },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(nav.query),
  useParams: () => ({ slug: "acme" }),
  useRouter: () => nav.router,
}));

const toasts = vi.hoisted(() => ({ told: [] as { text: string; description: unknown }[] }));
vi.mock("@/components/ui/Toaster", () => {
  const raise = (text: string, options: { description: unknown }) => {
    toasts.told.push({ text, description: options.description });
  };
  return { toast: { success: raise, info: raise, warning: raise, dismiss: () => undefined } };
});

import { AgentActivity } from "@/components/AgentActivity";
import { followLink, ScrollToHash } from "@/components/vx/ScrollToHash";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrolled = vi.fn();
let container: HTMLDivElement;
let root: Root;

function Contractors({ children }: { children?: ReactElement }) {
  return (
    <>
      <details id="milestone-m1">
        <summary>Design</summary>
        <button type="button">Pay now</button>
      </details>
      {children}
      <ScrollToHash />
    </>
  );
}

function render(element: ReactElement) {
  act(() => root.render(element));
}

function row(): HTMLDetailsElement {
  return document.getElementById("milestone-m1") as HTMLDetailsElement;
}

beforeEach(() => {
  nav.query = "";
  nav.router.push = vi.fn();
  toasts.told = [];
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
  window.history.replaceState(null, "", "/o/acme/contractors");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ScrollToHash", () => {
  it("opens the row the address names as the page arrives", () => {
    window.history.replaceState(null, "", "/o/acme/contractors#milestone-m1");
    render(<Contractors />);
    expect(row().open).toBe(true);
    expect(scrolled).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  });

  it("opens it after a navigation that changes the query without mounting the page again", () => {
    render(<Contractors />);
    expect(row().open).toBe(false);
    // A confirmed release's toast: every paid row shown, at the milestone's own.
    window.history.pushState(null, "", "/o/acme/contractors?history=all#milestone-m1");
    nav.query = "history=all";
    render(<Contractors />);
    expect(row().open).toBe(true);
  });

  it("opens it when a link changes only the fragment", () => {
    render(<Contractors />);
    window.history.pushState(null, "", "/o/acme/contractors#milestone-m1");
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(row().open).toBe(true);
  });

  it("leaves a row someone has closed closed when the page is read again", () => {
    window.history.replaceState(null, "", "/o/acme/contractors#milestone-m1");
    render(<Contractors />);
    row().open = false;
    render(<Contractors />);
    expect(row().open).toBe(false);
  });
});

describe("followLink", () => {
  it("opens the part of the page already open that a link names, and follows it", () => {
    render(<Contractors />);
    followLink(nav.router, "/o/acme/contractors#milestone-m1");
    expect(nav.router.push).toHaveBeenCalledWith("/o/acme/contractors#milestone-m1");
    expect(row().open).toBe(true);
  });

  it("leaves a link to another page, or to the same page with another query, to the page it lands on", () => {
    render(<Contractors />);
    followLink(nav.router, "/o/acme/approvals#milestone-m1");
    followLink(nav.router, "/o/acme/contractors?history=all#milestone-m1");
    expect(nav.router.push).toHaveBeenCalledTimes(2);
    expect(row().open).toBe(false);
  });
});

describe("a console toast for a milestone", () => {
  it("clicked with Contractors already open, opens the milestone's row there", async () => {
    const answers = [
      { running: null, head: 10, lastCycleAt: null, items: [] },
      {
        running: null,
        head: 11,
        lastCycleAt: null,
        items: [
          {
            seq: 11,
            text: "Held 40.00 USDC for Design from Puka for you.",
            detail: null,
            tone: "stopped",
            path: "/contractors#milestone-m1",
            pathLabel: "Decide in Contractors",
            txHash: null,
            txUrl: null,
            network: "arc-testnet",
          },
        ],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(answers.shift() ?? answers[answers.length - 1]), { status: 200 })),
    );
    const settle = async () => {
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    render(
      <Contractors>
        <AgentActivity lastCycleAt={null} />
      </Contractors>,
    );
    await act(settle);
    // The tab shown again asks at once: the hold arrives, and is told.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    });
    expect(toasts.told.map((told) => told.text)).toEqual(["Held 40.00 USDC for Design from Puka for you."]);

    const toastRoot = document.createElement("div");
    document.body.appendChild(toastRoot);
    const toastView = createRoot(toastRoot);
    act(() => toastView.render(toasts.told[0].description as ReactElement));
    const decide = [...toastRoot.querySelectorAll("button")].find((button) => button.textContent === "Decide in Contractors");
    expect(row().open).toBe(false);
    act(() => decide?.click());

    expect(nav.router.push).toHaveBeenCalledWith("/o/acme/contractors#milestone-m1");
    expect(row().open).toBe(true);
    act(() => toastView.unmount());
  });
});
