import { AuthError, connect, refreshInWorker } from "./lib/auth.js";
import { newIdempotencyKey } from "./lib/pkce.js";
import { captureClickedSelection } from "./lib/selection.js";

/**
 * Connect Vestiarion, and a token refresh, asked by the popup: both run here, since Chrome may close the popup while the
 * sign-in window is open or a refresh is on its way, and here one refresh runs at a time. Only this extension's own
 * pages can send these messages: it declares no externally_connectable.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "refresh") {
    refreshInWorker().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (message?.type !== "connect") return false;
  connect()
    .then(async (auth) => {
      sendResponse({ ok: true, workspace: auth.workspace });
      await chrome.action.openPopup().catch(() => {});
    })
    .catch((error) => sendResponse({ ok: false, message: error instanceof AuthError ? error.message : "Connecting did not work. Try again." }));
  return true;
});

/**
 * The context menu item Capture invoice with Vestiarion, shown only on a selection. A click reads that selection once,
 * keeps it for the popup in chrome.storage.session (memory only, gone when Chrome closes), and opens the popup, where
 * the person checks the fields before anything becomes a draft they send. Nothing is sent from here.
 */

const MENU_ID = "capture-invoice";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Capture invoice with Vestiarion", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = await captureClickedSelection(info, tab);
  if (!text.trim()) return;
  await chrome.storage.session.set({ pendingSelection: { text, idempotencyKey: newIdempotencyKey(), at: Date.now() } });
  try {
    await chrome.action.openPopup();
  } catch {
    // Where Chrome cannot open the popup itself, the badge says a capture waits for a click on the icon.
    await chrome.action.setBadgeText({ text: "1" });
    await chrome.action.setBadgeBackgroundColor({ color: "#3048c9" });
  }
});
