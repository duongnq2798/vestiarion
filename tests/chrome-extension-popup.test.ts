// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The extension's popup in a DOM (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C24, C25), with Chrome's
 * APIs and the network stubbed: the first-run screen, Connect, a capture by selection read once on a click, the fields
 * to check with what is missing, Send draft, Open in Vestiarion, a capture waiting from the context menu, Disconnect,
 * and what a document says shown as text, never as markup.
 */

const PACKAGE = path.join(process.cwd(), "extensions", "chrome-invoice-capture", "extension");
const CLIENT = "abcdefghijklmnopabcdefghijklmnop";
const BASE = "https://www.vestiarion.xyz";
const REVIEW_URL = `${BASE}/o/northstar/invoices?review=captured`;
const SELECTED = "Northwind Hosting\nInvoice number: INV-2207\nTotal due: 200.00 USDC";
const body = readFileSync(path.join(PACKAGE, "popup.html"), "utf8").split("<body>")[1].split("</body>")[0];

const DRAFT = {
  id: "7c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a10",
  state: "draft",
  source: "selection",
  document: { kind: "text", sha256: "a".repeat(64) },
  fields: { supplierName: "Northwind Hosting", invoiceNumber: "INV-2207", amount: "200.00", currency: "USDC", invoiceDate: null, dueDate: null, poReference: null, memo: null },
  missing: [{ field: "dueDate", message: "No due date was read. Add the day it is due." }],
  notes: ['The model\'s note: <img src="x" onerror="alert(1)"> asks to be paid elsewhere.'],
  capturedAt: "2026-10-15T09:00:00Z",
  sentAt: null,
  reviewUrl: null,
};

type Store = Map<string, unknown>;

function area(map: Store) {
  return {
    get: async (keys?: string | string[]) => {
      const list = typeof keys === "string" ? [keys] : (keys ?? [...map.keys()]);
      return Object.fromEntries(list.filter((key) => map.has(key)).map((key) => [key, structuredClone(map.get(key))]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    remove: async (keys: string | string[]) => {
      for (const key of ([] as string[]).concat(keys)) map.delete(key);
    },
  };
}

let local: Store;
let session: Store;
let requests: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
let chromeApi: ReturnType<typeof stubChrome>;

function stubChrome() {
  return {
    storage: { local: area(local), session: area(session) },
    runtime: { id: CLIENT, sendMessage: vi.fn(), getURL: (file: string) => `chrome-extension://${CLIENT}/${file}` },
    identity: { getRedirectURL: () => `https://${CLIENT}.chromiumapp.org/`, launchWebAuthFlow: vi.fn() },
    action: { setBadgeText: vi.fn(async () => {}), openPopup: vi.fn(async () => {}) },
    tabs: { query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn<(injection: { target: { tabId: number } }) => Promise<Array<{ result: string }>>>(async () => [{ result: SELECTED }]) },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true), onAlarm: { addListener: vi.fn() } },
  };
}

function json(status: number, value: unknown) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  local = new Map();
  session = new Map();
  requests = [];
  chromeApi = stubChrome();
  vi.stubGlobal("chrome", chromeApi);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const parsed = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
      requests.push({ url, method, headers: new Headers(init.headers), body: parsed });
      if (url === `${BASE}/api/extension/v1/session`) return json(200, { data: { workspace: { name: "Northstar", slug: "northstar" } } });
      if (url === `${BASE}/api/extension/v1/invoice-drafts` && method === "POST") return json(201, { data: DRAFT });
      if (url === `${BASE}/api/extension/v1/invoice-drafts/${DRAFT.id}` && method === "PATCH") return json(200, { data: { ...DRAFT, fields: { ...DRAFT.fields, ...(parsed as object) } } });
      if (url === `${BASE}/api/extension/v1/invoice-drafts/${DRAFT.id}/send`) return json(200, { data: { ...DRAFT, state: "sent", reviewUrl: REVIEW_URL } });
      if (url === `${BASE}/api/extension/v1/revoke`) return json(200, {});
      return json(404, { error: { code: "not_found", message: "Not found." } });
    })
  );
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const visible = () => ["first-run", "connect", "home", "review", "sent"].filter((id) => !$(id).hidden);

async function open() {
  vi.resetModules();
  await import("../extensions/chrome-invoice-capture/extension/popup.js");
}

/** Connected: the refresh token kept on disk, the access token in memory only (M6). */
function connected() {
  local.set("firstRunDone", true);
  local.set("auth", { refreshToken: `vxr_${"b".repeat(43)}`, workspace: { name: "Northstar", slug: "northstar" } });
  session.set("access", { accessToken: `vxa_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
}

describe("the popup", () => {
  it("first says what is sent and when, then asks to connect", async () => {
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["first-run"]));
    expect($("first-run").textContent).toContain("Nothing on a page is read until you press");
    expect($("first-run").textContent).toContain("No analytics");
    $("first-run-ok").click();
    await vi.waitFor(() => expect(visible()).toEqual(["connect"]));
    expect(local.get("firstRunDone")).toBe(true);
  });

  it("connects through the service worker, which runs Chrome's sign-in window", async () => {
    local.set("firstRunDone", true);
    chromeApi.runtime.sendMessage.mockImplementation(async () => {
      connected();
      return { ok: true, workspace: { name: "Northstar", slug: "northstar" } };
    });
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["connect"]));
    $("connect-button").click();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({ type: "connect" });
    expect($("workspace").textContent).toBe("Northstar");
  });

  it("reads the selection only on a click, shows the fields with what is missing, and writes notes as text", async () => {
    connected();
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();

    $("capture-selection").click();
    await vi.waitFor(() => expect(visible()).toEqual(["review"]));
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeApi.scripting.executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 7 } });
    const capture = requests.find((request) => request.method === "POST" && request.url.endsWith("/invoice-drafts"))!;
    expect(capture.body).toEqual({ source: "selection", text: SELECTED });
    expect(capture.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(capture.headers.get("authorization")).toBe(`Bearer vxa_${"a".repeat(43)}`);

    const form = document.getElementById("draft-form") as HTMLFormElement;
    expect((form.elements.namedItem("supplierName") as HTMLInputElement).value).toBe("Northwind Hosting");
    expect($("missing").textContent).toContain("No due date was read. Add the day it is due.");
    expect($("notes").textContent).toContain('<img src="x" onerror="alert(1)">');
    expect($("notes").querySelector("img")).toBeNull();

    const due = form.elements.namedItem("dueDate") as HTMLInputElement;
    due.value = "2026-10-31";
    due.dispatchEvent(new Event("input", { bubbles: true }));
    expect($("missing").textContent).not.toContain("No due date was read.");

    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(visible()).toEqual(["sent"]));
    const edit = requests.find((request) => request.method === "PATCH")!;
    expect(edit.body).toMatchObject({ dueDate: "2026-10-31", amount: "200.00" });
    expect(requests.some((request) => request.url.endsWith(`/${DRAFT.id}/send`))).toBe(true);
    expect($("sent-text").textContent).toContain("Captured drafts on Bills & receivables");
    expect(local.has("currentDraftId")).toBe(false);

    $("open").click();
    await vi.waitFor(() => expect(chromeApi.tabs.create).toHaveBeenCalledWith({ url: REVIEW_URL }));
  });

  it("refuses an amount Vestiarion would not take before sending anything", async () => {
    connected();
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    $("capture-selection").click();
    await vi.waitFor(() => expect(visible()).toEqual(["review"]));
    const form = document.getElementById("draft-form") as HTMLFormElement;
    const amount = form.elements.namedItem("amount") as HTMLInputElement;
    amount.value = "1,200.00";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect($("status").textContent).toContain("Use a positive amount"));
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("shows a selection the context menu kept, and sends it only on a click, with the key kept for it", async () => {
    connected();
    session.set("pendingSelection", { text: SELECTED, idempotencyKey: "menu-key-1", at: Date.now() });
    await open();
    await vi.waitFor(() => expect($("pending").hidden).toBe(false));
    expect(visible()).toEqual(["home"]);
    expect($("pending-text").textContent).toBe(SELECTED);
    expect(requests.some((request) => request.url.endsWith("/invoice-drafts"))).toBe(false);

    $("pending-send").click();
    await vi.waitFor(() => expect(visible()).toEqual(["review"]));
    const capture = requests.find((request) => request.method === "POST" && request.url.endsWith("/invoice-drafts"))!;
    expect(capture.headers.get("idempotency-key")).toBe("menu-key-1");
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();
    expect(session.has("pendingSelection")).toBe(false);
  });

  it("lets a person drop a selection the context menu kept, and drops one older than 5 minutes by itself", async () => {
    connected();
    session.set("pendingSelection", { text: SELECTED, idempotencyKey: "menu-key-2", at: Date.now() });
    await open();
    await vi.waitFor(() => expect($("pending").hidden).toBe(false));
    $("pending-drop").click();
    await vi.waitFor(() => expect($("pending").hidden).toBe(true));
    expect(session.has("pendingSelection")).toBe(false);

    session.set("pendingSelection", { text: SELECTED, idempotencyKey: "menu-key-3", at: Date.now() - 5 * 60_000 - 1 });
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    expect($("pending").hidden).toBe(true);
    expect(session.has("pendingSelection")).toBe(false);
    expect(requests.some((request) => request.url.endsWith("/invoice-drafts"))).toBe(false);
  });

  it("says when nothing is selected, and sends nothing", async () => {
    connected();
    chromeApi.scripting.executeScript.mockResolvedValue([{ result: "" }]);
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    $("capture-selection").click();
    await vi.waitFor(() => expect($("status").textContent).toContain("No text is selected on this page."));
    expect(requests.some((request) => request.url.endsWith("/invoice-drafts"))).toBe(false);
  });

  it("disconnects: Vestiarion revokes the refresh token, and the extension forgets it", async () => {
    connected();
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    $("disconnect").click();
    await vi.waitFor(() => expect(visible()).toEqual(["connect"]));
    const revoke = requests.find((request) => request.url === `${BASE}/api/extension/v1/revoke`)!;
    expect(String(revoke.body)).toContain(`token=vxr_${"b".repeat(43)}`);
    expect(String(revoke.body)).toContain(`client_id=${CLIENT}`);
    expect(local.has("auth")).toBe(false);
    expect(session.has("access")).toBe(false);
  });

  it("asks the service worker to refresh on a 401, and asks to connect again once the connection has ended", async () => {
    connected();
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith("/invoice-drafts") ? json(401, { error: { code: "unauthorized", message: "Connect the extension to Vestiarion again." } }) : json(200, { data: { workspace: { name: "Northstar", slug: "northstar" } } })
    );
    // The worker's refresh is refused, and it forgets the tokens.
    chromeApi.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "refresh") local.delete("auth");
      return { ok: false };
    });
    await open();
    await vi.waitFor(() => expect(visible()).toEqual(["home"]));
    $("capture-selection").click();
    await vi.waitFor(() => expect(visible()).toEqual(["connect"]));
    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({ type: "refresh" });
    expect($("status").textContent).toContain("This connection has ended. Connect Vestiarion again.");
  });
});

describe("the service worker's refresh", () => {
  const STORED = { refreshToken: `vxr_${"b".repeat(43)}`, workspace: { name: "Northstar", slug: "northstar" } };
  const tokenCalls = () => requests.filter((request) => request.url === `${BASE}/api/extension/v1/token`);

  async function worker() {
    vi.resetModules();
    return import("../extensions/chrome-invoice-capture/extension/lib/auth.js");
  }

  it("runs one refresh at a time, and stores the new pair", async () => {
    local.set("auth", STORED);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), method: "POST", headers: new Headers(init?.headers), body: init?.body });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json(200, { access_token: `vxa_${"c".repeat(43)}`, refresh_token: `vxr_${"d".repeat(43)}`, expires_in: 3600, workspace: STORED.workspace });
    });
    const { refreshInWorker } = await worker();
    expect(await Promise.all([refreshInWorker(), refreshInWorker()])).toEqual([true, true]);
    expect(tokenCalls()).toHaveLength(1);
    expect(String(tokenCalls()[0].body)).toContain(`refresh_token=${STORED.refreshToken}`);
    expect((local.get("auth") as typeof STORED).refreshToken).toBe(`vxr_${"d".repeat(43)}`);
    // Only the refresh token goes to disk; the access token stays in memory.
    expect(local.get("auth")).not.toHaveProperty("accessToken");
    expect(session.get("access")).toMatchObject({ accessToken: `vxa_${"c".repeat(43)}` });
  });

  it("forgets the pair Vestiarion refused, and only that pair", async () => {
    local.set("auth", STORED);
    vi.mocked(fetch).mockImplementation(async () => json(400, { error: "invalid_grant", error_description: "The refresh token is not valid. Connect again." }));
    const { refreshInWorker } = await worker();
    expect(await refreshInWorker()).toBe(false);
    expect(local.has("auth")).toBe(false);

    // A pair stored while the refused one was on its way is kept.
    local.set("auth", STORED);
    vi.mocked(fetch).mockImplementation(async () => {
      local.set("auth", { ...STORED, refreshToken: `vxr_${"e".repeat(43)}` });
      return json(400, { error: "invalid_grant", error_description: "The refresh token is not valid. Connect again." });
    });
    expect(await refreshInWorker()).toBe(true);
    expect((local.get("auth") as typeof STORED).refreshToken).toBe(`vxr_${"e".repeat(43)}`);
  });

  it("keeps the pair when Vestiarion did not answer", async () => {
    local.set("auth", STORED);
    vi.mocked(fetch).mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { refreshInWorker } = await worker();
    expect(await refreshInWorker()).toBe(false);
    expect(local.get("auth")).toEqual(STORED);
  });
});

describe("the service worker", () => {
  it("keeps the extension's storage from content scripts, where Chrome allows it", async () => {
    const setAccessLevel = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      ...chromeApi,
      storage: { ...chromeApi.storage, local: { ...chromeApi.storage.local, setAccessLevel } },
      runtime: { ...chromeApi.runtime, onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
      contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    });
    vi.resetModules();
    await import("../extensions/chrome-invoice-capture/extension/background.js");
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("drops a selection from the context menu after 5 minutes with an alarm, whether or not the popup opens again", async () => {
    let onClicked: ((info: unknown, tab: unknown) => Promise<void>) | undefined;
    let onAlarm: ((alarm: { name: string }) => Promise<void>) | undefined;
    const alarms = {
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn((listener: typeof onAlarm) => (onAlarm = listener)) },
    };
    vi.stubGlobal("chrome", {
      ...chromeApi,
      action: { ...chromeApi.action, setBadgeBackgroundColor: vi.fn(async () => {}) },
      runtime: { ...chromeApi.runtime, onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
      contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn((listener: typeof onClicked) => (onClicked = listener)) } },
      alarms,
    });
    vi.resetModules();
    await import("../extensions/chrome-invoice-capture/extension/background.js");

    await onClicked!({ menuItemId: "capture-invoice", selectionText: SELECTED, frameId: 0 }, { id: 7 });
    expect(session.get("pendingSelection")).toMatchObject({ text: SELECTED });
    expect(alarms.create).toHaveBeenCalledWith("pending-selection", { delayInMinutes: 5 });

    // The alarm finds the selection still fresh (a newer one replaced it): it is kept, and the alarm set for the rest.
    alarms.create.mockClear();
    await onAlarm!({ name: "pending-selection" });
    expect(session.has("pendingSelection")).toBe(true);
    expect(alarms.create).toHaveBeenCalledTimes(1);

    // Five minutes on, it is removed, though the popup never opened.
    session.set("pendingSelection", { text: SELECTED, idempotencyKey: "menu-key", at: Date.now() - 5 * 60_000 });
    await onAlarm!({ name: "pending-selection" });
    expect(session.has("pendingSelection")).toBe(false);
    expect(chromeApi.action.setBadgeText).toHaveBeenCalledWith({ text: "" });

    // Another alarm's name is not this one's.
    session.set("pendingSelection", { text: SELECTED, idempotencyKey: "menu-key", at: Date.now() - 10 * 60_000 });
    await onAlarm!({ name: "something-else" });
    expect(session.has("pendingSelection")).toBe(true);
  });
});
