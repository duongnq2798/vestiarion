import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TryIt, { AUTHENTICATION_HINT, runTryIt, TryItResultView, type TryItOperation } from "@/components/docs/TryIt";
import { operationById } from "@/lib/api/openapi";

/**
 * "Try it", as the pure request logic it runs on Send (`runTryIt`) and the
 * markup it renders for a result (`TryItResultView`). The suite runs in
 * vitest's `node` environment (see `vitest.config.ts`): there is no jsdom or
 * `@testing-library/react` in this repo, so a real click on a real DOM cannot
 * be simulated. `runTryIt` and `TryItResultView` are split out of the
 * component precisely so the brief's behaviour — what Send does, and what
 * each outcome renders — is exercised directly, calling the same function the
 * component's Send handler calls and rendering the same function its markup
 * comes from, the way `tests/control-ui.test.tsx` and `tests/decision-card.test.tsx`
 * check other client components by their rendered markup.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node);
const origin = "https://docs.test";

function op(id: string): TryItOperation {
  const found = operationById(id);
  if (!found) throw new Error(`no such operation: ${id}`);
  return { id: found.id, path: found.path, params: found.params };
}

describe("runTryIt", () => {
  it("sends the trimmed key only as a Bearer header, to this origin's /api/v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], page: { nextCursor: null } }), { status: 200 }));
    const result = await runTryIt(op("list-invoices"), origin, "  vxk_abc_def\n", {}, fetchMock);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${origin}/api/v1/invoices`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vxk_abc_def");
    expect(result).toMatchObject({ kind: "ok", status: 200, ok: true });
  });

  it("sends no Authorization header when the key is blank", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await runTryIt(op("list-invoices"), origin, "   ", {}, fetchMock);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.hasOwn((init.headers ?? {}) as object, "Authorization")).toBe(false);
  });

  it("never touches window or any storage — none exist in this environment, and the call still succeeds", async () => {
    // The strongest proof available without jsdom: `runTryIt` is called where
    // these globals genuinely do not exist, so touching any of them would
    // throw, not silently no-op.
    expect(typeof window).toBe("undefined");
    expect(typeof Storage).toBe("undefined");
    expect(typeof localStorage).toBe("undefined");
    expect(typeof sessionStorage).toBe("undefined");

    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await runTryIt(op("get-status"), origin, "vxk_a", {}, fetchMock);
    expect(result.kind).toBe("ok");
  });

  it("never writes the key to storage, even when storage is present", async () => {
    const setItem = vi.fn();
    const stub = { setItem, getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", stub);
    vi.stubGlobal("sessionStorage", stub);
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      await runTryIt(op("get-status"), origin, "vxk_a", {}, fetchMock);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a network failure without retrying", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await runTryIt(op("list-invoices"), origin, "vxk_a", {}, fetchMock);

    expect(result).toEqual({ kind: "network-error" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(html(<TryItResultView result={result} />)).toContain("The request did not complete.");
  });

  it("refuses to send when the built URL would leave this origin's /api/v1/", async () => {
    const rogue: TryItOperation = { id: "rogue", path: "/not-api/v1/thing", params: [] };
    const fetchMock = vi.fn();
    const result = await runTryIt(rogue, origin, "vxk_a", {}, fetchMock);

    expect(result).toEqual({ kind: "refused" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(html(<TryItResultView result={result} />)).toContain("Refused");
  });

  it("keeps a path parameter containing '../' url-encoded and inside /api/v1/, rather than refusing or escaping it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const result = await runTryIt(op("get-counterparty"), origin, "vxk_a", { id: "../../etc/passwd" }, fetchMock);

    expect(result.kind).toBe("ok");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${origin}/api/v1/counterparties/..%2F..%2Fetc%2Fpasswd`);
    expect(url.startsWith(`${origin}/api/v1/`)).toBe(true);
  });
});

describe("TryItResultView", () => {
  it("shows the API's own 401 body and the hint, linked to the authentication page", async () => {
    const body = { error: { code: "unauthorized", message: "A valid API key is required." } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 }));
    const result = await runTryIt(op("list-invoices"), origin, "bad-key", {}, fetchMock);

    expect(result).toMatchObject({ kind: "ok", status: 401, ok: false });
    const markup = html(<TryItResultView result={result} />);
    expect(markup).toContain("unauthorized");
    expect(markup).toContain("A valid API key is required.");
    // React encodes the apostrophe in the hint's own text as `&#x27;`.
    expect(markup).toContain(AUTHENTICATION_HINT.replace("'", "&#x27;"));
    expect(markup).toContain('href="/docs/get-started/authentication"');
  });

  it("gives a 2xx the proof tone and anything else the refused tone", async () => {
    const ok = await runTryIt(op("get-status"), origin, "k", {}, vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const bad = await runTryIt(op("get-status"), origin, "k", {}, vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    expect(html(<TryItResultView result={ok} />)).toContain("border-proof-line");
    expect(html(<TryItResultView result={bad} />)).toContain("border-refused-line");
  });

  it("renders nothing before a request is sent", () => {
    expect(html(<TryItResultView result={null} />)).toBe("");
  });
});

describe("TryIt", () => {
  it("labels the key field, masks it by default, and offers Send", () => {
    const markup = html(<TryIt op={op("get-status")} />);
    expect(markup).toContain(">Workspace API key<");
    expect(markup).toContain('type="password"');
    expect(markup).toContain(">Send<");
  });
});
