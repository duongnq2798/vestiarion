import { AuthError, connect, refreshInWorker } from "./lib/auth.js";
import { newIdempotencyKey } from "./lib/pkce.js";
import { captureClickedSelection } from "./lib/selection.js";

/**
 * The refresh token on disk is for this extension's own pages and this worker only. Session storage is so already; local
 * storage is exposed to content scripts unless told otherwise, and the extension has none, but where this Chrome lets
 * local storage be closed to them, it is. An older Chrome that cannot answers nothing, and nothing else changes.
 */
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
} catch {
  // Only session storage takes an access level in this Chrome.
}

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
 * keeps it for the popup in chrome.storage.session (memory only, gone when Chrome closes), and opens the popup, which
 * shows it and sends it to Vestiarion only when the person presses Send to Vestiarion, within 5 minutes. An alarm
 * removes it after those 5 minutes, whether or not the popup opens again. Nothing is sent from here.
 */

const MENU_ID = "capture-invoice";
const PENDING_ALARM = "pending-selection";
/** The popup's PENDING_MS, in the minutes an alarm takes. */
const PENDING_MINUTES = 5;

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PENDING_ALARM) return;
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection) return;
  const left = Number(pendingSelection.at) + PENDING_MINUTES * 60_000 - Date.now();
  if (left > 0) {
    // A newer selection replaced the one this alarm was set for: it waits its own 5 minutes.
    await chrome.alarms.create(PENDING_ALARM, { delayInMinutes: left / 60_000 });
    return;
  }
  await chrome.storage.session.remove("pendingSelection");
  await chrome.action.setBadgeText({ text: "" }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Capture invoice with Vestiarion", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = await captureClickedSelection(info, tab);
  if (!text.trim()) return;
  await chrome.storage.session.set({ pendingSelection: { text, idempotencyKey: newIdempotencyKey(), at: Date.now() } });
  await chrome.alarms.create(PENDING_ALARM, { delayInMinutes: PENDING_MINUTES });
  try {
    await chrome.action.openPopup();
  } catch {
    // Where Chrome cannot open the popup itself, the badge says a capture waits for a click on the icon.
    await chrome.action.setBadgeText({ text: "1" });
    await chrome.action.setBadgeBackgroundColor({ color: "#3048c9" });
  }
});
