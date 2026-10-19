// @vitest-environment happy-dom
import { act, type CSSProperties, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CopyButton } from "@/components/ui/CopyButton";
import { Reveal, SEEN_MARGIN } from "@/components/ui/Reveal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Reveal", () => {
  it("hides nothing in the server’s HTML", () => {
    const markup = html(
      <Reveal delay={120}>
        <p>Measured</p>
      </Reveal>
    );
    expect(markup).toContain("<p>Measured</p>");
    expect(markup).not.toContain("data-reveal");
    expect(markup).not.toContain("opacity");
  });

  it("hides nothing in the server’s HTML in a sequence either, and fades no item there", () => {
    const markup = html(
      <Reveal sequence stagger={140}>
        <ul>
          <li className="seq">Purchase order on file</li>
          <li className="seq">Goods received</li>
        </ul>
      </Reveal>
    );
    expect(markup).toContain('<li class="seq">Purchase order on file</li>');
    expect(markup).toContain('<li class="seq">Goods received</li>');
    expect(markup).not.toMatch(/data-(seq|reveal)/);
    expect(markup).not.toContain("opacity");
    expect(markup).toContain("--stagger:140ms");
  });
});

/**
 * In a DOM: what starts below the fold is hidden once the page hydrates, then shown when it is seen, and what the
 * reader jumped past is shown at once (landing motion M4). The browser's observer is stood in for, and handed the
 * entries a scroll would give it.
 */
describe("Reveal in the browser", () => {
  type Entry = { isIntersecting: boolean; boundingClientRect: { top: number; bottom: number } };
  let observed: { callback: (entries: Entry[]) => void; options?: IntersectionObserverInit } | null = null;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  const Observer = globalThis.IntersectionObserver;

  class StandInObserver {
    constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
      observed = { callback, options };
    }
    observe() {}
    disconnect() {}
  }

  /** Mounts `node` with its top `top` px below the viewport's top. */
  function mount(node: ReactElement, top: number): HTMLElement {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.IntersectionObserver = StandInObserver as unknown as typeof IntersectionObserver;
    HTMLElement.prototype.getBoundingClientRect = () => ({ top, bottom: top + 200, left: 0, right: 0, width: 0, height: 200, x: 0, y: top, toJSON: () => ({}) });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(node));
    return container.firstElementChild as HTMLElement;
  }

  /** The observer reports the element in its root, its top `top` px below the viewport's top (negative: above it). */
  const seen = (top: number) => act(() => observed!.callback([{ isIntersecting: true, boundingClientRect: { top, bottom: top + 200 } }]));

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    observed = null;
    HTMLElement.prototype.getBoundingClientRect = measure;
    globalThis.IntersectionObserver = Observer;
  });

  it("leaves alone what is already on screen when the page hydrates", () => {
    const element = mount(<Reveal>On screen</Reveal>, 120);
    expect(element.dataset.reveal).toBeUndefined();
    expect(observed).toBeNull();
  });

  it("hides what starts below the fold, and shows it once it is seen", () => {
    const element = mount(<Reveal>Below</Reveal>, window.innerHeight + 600);
    expect(element.dataset.reveal).toBe("hidden");
    seen(300);
    expect(element.dataset.reveal).toBe("shown");
  });

  it("counts the page above the viewport as seen, so content jumped past is noticed", () => {
    mount(<Reveal>Below</Reveal>, window.innerHeight + 600);
    expect(observed!.options!.rootMargin).toBe(SEEN_MARGIN);
    // Taller than any page: the landing is about 18,000 px at phone width.
    expect(Number.parseInt(SEEN_MARGIN, 10)).toBeGreaterThanOrEqual(50_000);
  });

  it("shows at once, as the server drew it, what the reader jumped past", () => {
    const element = mount(<Reveal>Below</Reveal>, window.innerHeight + 600);
    seen(-4000);
    expect(element.dataset.reveal).toBeUndefined();
  });

  it("in a sequence, leaves the element itself in place and numbers its items in the order they are written", () => {
    const element = mount(
      <Reveal sequence>
        <ul>
          <li className="seq">One</li>
          <li className="seq">Two</li>
          <li className="seq" style={{ "--i": 5 } as CSSProperties}>
            Last
          </li>
        </ul>
      </Reveal>,
      window.innerHeight + 600
    );
    expect(element.dataset.reveal).toBeUndefined();
    expect(element.dataset.seq).toBe("hidden");
    const places = [...element.querySelectorAll<HTMLElement>(".seq")].map((item) => item.style.getPropertyValue("--i"));
    expect(places).toEqual(["0", "1", "5"]);
    seen(300);
    expect(element.dataset.seq).toBe("shown");
  });

  it("in a sequence too, shows at once what the reader jumped past", () => {
    const element = mount(
      <Reveal sequence>
        <p className="seq">One</p>
      </Reveal>,
      window.innerHeight + 600
    );
    seen(-4000);
    expect(element.dataset.seq).toBeUndefined();
  });
});

describe("Tabs", () => {
  const tabs = (
    <Tabs defaultValue="manual">
      <TabsList aria-label="Invoice intake">
        <TabsTrigger value="manual">Enter one invoice</TabsTrigger>
        <TabsTrigger value="csv">Import CSV</TabsTrigger>
      </TabsList>
      <TabsContent value="manual">Manual form</TabsContent>
      <TabsContent value="csv">CSV form</TabsContent>
    </Tabs>
  );

  it("renders the default tab’s panel on the server", () => {
    const markup = html(tabs);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Manual form");
    expect(markup).not.toContain("CSV form");
  });

  it("marks exactly one tab as selected", () => {
    expect(html(tabs).match(/data-tab-indicator/g)).toHaveLength(1);
  });

  it("scrolls a list that does not fit inside itself, not the page", () => {
    const list = html(tabs).match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? "";
    expect(list).toContain("overflow-x-auto");
    expect(list).toContain("max-w-full");
  });
});

describe("CopyButton", () => {
  it("names itself for screen readers when it is only an icon", () => {
    const markup = html(
      <TooltipProvider>
        <CopyButton value="0xabc" label="Copy transaction hash" />
      </TooltipProvider>
    );
    expect(markup).toContain('aria-label="Copy transaction hash"');
  });

  it("shows its text when it has some", () => {
    expect(html(<CopyButton value="https://example.com/invite">Copy link</CopyButton>)).toContain("Copy link");
  });
});
