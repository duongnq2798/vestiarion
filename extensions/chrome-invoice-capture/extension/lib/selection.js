import { MAX_SELECTION_CHARS } from "./config.js";

/**
 * The text a person selected in the active tab, read once when they press Capture: activeTab gives the extension that
 * tab for this one press, and scripting runs the one function below in it. Nothing runs on a page otherwise.
 */

/** Runs in the page: the selection's text, and nothing else of the page. */
function selectedText() {
  return String(globalThis.getSelection?.() ?? "");
}

/** The longest selection among the frames the extension may read, cut to the reader's limit. */
export async function captureActiveSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return "";
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: selectedText });
  } catch {
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectedText });
    } catch {
      return "";
    }
  }
  const texts = results.map((result) => (typeof result?.result === "string" ? result.result : "")).sort((a, b) => b.length - a.length);
  return (texts[0] ?? "").slice(0, MAX_SELECTION_CHARS);
}

/** The selection a context-menu click was made on, in the frame it was made in; the menu's own text when none can be read. */
export async function captureClickedSelection(info, tab) {
  let text = typeof info.selectionText === "string" ? info.selectionText : "";
  if (tab?.id !== undefined) {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: selectedText });
      if (typeof result?.result === "string" && result.result.trim()) text = result.result;
    } catch {
      // A page no extension may run in, such as Chrome's PDF viewer: the menu's own text is used.
    }
  }
  return text.slice(0, MAX_SELECTION_CHARS);
}
