import { ApiError, captureFile, captureSelection, getDraft, saveDraft, sendDraft, session } from "./lib/api.js";
import { AuthError, disconnect, getAuth } from "./lib/auth.js";
import { API_BASE, MAX_FILE_BYTES } from "./lib/config.js";
import { amountProblem, FIELDS, missingOf } from "./lib/fields.js";
import { newIdempotencyKey } from "./lib/pkce.js";
import { captureActiveSelection } from "./lib/selection.js";

/**
 * The popup: a first-run screen saying what is sent and when, Connect, capture by selection or file, the fields to
 * check with what is missing, Send draft, and Open in Vestiarion. Every word that comes from a page or a document is
 * set as text, never as markup. Nothing is sent anywhere but Vestiarion, and nothing about an invoice is counted.
 */

const SCREENS = ["first-run", "connect", "home", "review", "sent"];
const $ = (id) => document.getElementById(id);
const form = $("draft-form");
/** Opened as a tab (for a file, where the file window would close the popup): there is no page to capture from. */
const inTab = new URLSearchParams(location.search).get("view") === "tab";

let current = null;
let reviewUrl = null;

function show(name) {
  for (const screen of SCREENS) $(screen).hidden = screen !== name;
}

function say(message, tone = "info") {
  const status = $("status");
  status.textContent = message ?? "";
  status.className = tone === "error" ? "status error" : "status";
}

function setWorkspace(workspace) {
  const label = $("workspace");
  label.hidden = !workspace;
  label.textContent = workspace ? workspace.name : "";
  label.title = workspace ? `Drafts go to ${workspace.name}` : "";
}

function errorText(error) {
  return error instanceof ApiError || error instanceof AuthError ? error.message : "Something went wrong. Try again in a moment.";
}

function renderList(list, items) {
  list.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    })
  );
}

async function needsConnecting(error) {
  if (!(error instanceof ApiError) || error.status !== 401) return false;
  setWorkspace(null);
  show("connect");
  say(error.message, "error");
  return true;
}

function readForm() {
  const fields = {};
  for (const field of FIELDS) {
    const value = form.elements.namedItem(field.name).value.trim();
    fields[field.name] = value === "" ? null : value;
  }
  return fields;
}

function renderMissing() {
  const fields = readForm();
  const problem = amountProblem(fields.amount);
  const amount = form.elements.namedItem("amount");
  if (problem) amount.setAttribute("aria-invalid", "true");
  else amount.removeAttribute("aria-invalid");
  renderList($("missing"), [...(problem ? [problem] : []), ...missingOf(fields).map((missing) => missing.message)]);
}

function ensureOption(select, value) {
  if (!value || [...select.options].some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = value;
  select.append(option);
}

function showSent(draft) {
  current = null;
  reviewUrl = typeof draft.reviewUrl === "string" && draft.reviewUrl.startsWith(`${API_BASE}/`) ? draft.reviewUrl : null;
  const workspace = $("workspace").textContent || "your workspace";
  $("sent-text").textContent =
    draft.state === "sent"
      ? `The draft waits in ${workspace} under Captured drafts on Bills & receivables. Nothing is paid until a person adds it as a bill there.`
      : `This draft was already ${draft.state === "confirmed" ? "added as a bill" : "discarded"} in ${workspace}.`;
  $("open").hidden = reviewUrl === null;
  show("sent");
}

async function review(draft) {
  if (draft.state !== "draft") {
    await chrome.storage.local.remove("currentDraftId");
    showSent(draft);
    return;
  }
  current = draft;
  await chrome.storage.local.set({ currentDraftId: draft.id });
  for (const field of FIELDS) {
    const input = form.elements.namedItem(field.name);
    const value = draft.fields?.[field.name] ?? "";
    if (field.type === "currency") ensureOption(input, value);
    input.value = value;
  }
  renderList($("notes"), Array.isArray(draft.notes) ? draft.notes : []);
  renderMissing();
  show("review");
}

/** How long a selection the context menu kept waits for Send to Vestiarion. */
const PENDING_MS = 5 * 60_000;

/** The selection the context menu kept, while it is fresh; an older one is dropped. Shown, never sent by itself. */
async function freshPending() {
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection) return null;
  if (!pendingSelection.text || !(Date.now() - Number(pendingSelection.at) <= PENDING_MS)) {
    await chrome.storage.session.remove("pendingSelection");
    return null;
  }
  return pendingSelection;
}

async function showPending() {
  const pending = inTab ? null : await freshPending();
  $("pending").hidden = !pending;
  $("pending-text").textContent = pending ? pending.text : "";
}

/**
 * Captures text with a key kept for it, so a retry of the same text makes no second draft: the context menu's own key
 * for its selection, or one kept for the last text captured here.
 */
async function captureText(text, button, idempotencyKey) {
  if (!text.trim()) {
    say("Select the invoice's text on the page first, then press Capture selected text.", "error");
    return;
  }
  let key = idempotencyKey;
  if (!key) {
    const { lastCapture } = await chrome.storage.session.get("lastCapture");
    key = lastCapture?.text === text && lastCapture.idempotencyKey ? lastCapture.idempotencyKey : newIdempotencyKey();
    await chrome.storage.session.set({ lastCapture: { text, idempotencyKey: key } });
  }
  button.disabled = true;
  say("Reading the invoice…");
  try {
    const draft = await captureSelection(text, key);
    await chrome.storage.session.remove(["pendingSelection", "lastCapture"]);
    say("");
    await review(draft);
  } catch (error) {
    // A capture Vestiarion refused for what it is (unreadable, too large, a key used for another) is not tried again;
    // one that did not arrive, or met a limit, may be tried again with the same key.
    if (error instanceof ApiError && [400, 409, 413, 415, 422].includes(error.status)) await chrome.storage.session.remove(["pendingSelection", "lastCapture"]);
    if (!(await needsConnecting(error))) say(errorText(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function showConnected() {
  const auth = await getAuth();
  if (!auth) {
    setWorkspace(null);
    show("connect");
    return;
  }
  setWorkspace(auth.workspace);
  $("capture-selection").hidden = inTab;
  $("in-tab").hidden = inTab;
  await showPending();
  if (!$("pending").hidden) {
    // A selection waits for Send to Vestiarion: that comes before a draft in progress.
    show("home");
    return;
  }
  const { currentDraftId } = await chrome.storage.local.get("currentDraftId");
  if (currentDraftId) {
    try {
      const draft = await getDraft(currentDraftId);
      if (draft.state === "draft") {
        await review(draft);
        return;
      }
    } catch (error) {
      if (await needsConnecting(error)) return;
    }
    await chrome.storage.local.remove("currentDraftId");
  }
  show("home");
  try {
    const data = await session();
    setWorkspace(data.workspace);
    const { auth: stored } = await chrome.storage.local.get("auth");
    if (stored) await chrome.storage.local.set({ auth: { ...stored, workspace: data.workspace } });
  } catch (error) {
    await needsConnecting(error);
  }
}

$("pending-send").addEventListener("click", async (event) => {
  // Kept before the await: the event's currentTarget is gone once it has been dispatched.
  const button = event.currentTarget;
  const pending = await freshPending();
  if (!pending) {
    await showPending();
    say("That selection was dropped after 5 minutes. Select the text again.", "error");
    return;
  }
  await captureText(pending.text, button, pending.idempotencyKey);
  await showPending();
});

$("pending-drop").addEventListener("click", async () => {
  await chrome.storage.session.remove("pendingSelection");
  await showPending();
  say("");
});

$("first-run-ok").addEventListener("click", async () => {
  await chrome.storage.local.set({ firstRunDone: true });
  await showConnected();
});

$("connect-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  say("Opening Vestiarion…");
  // The service worker runs the sign-in window: Chrome may close this popup while it is open.
  const answer = await chrome.runtime.sendMessage({ type: "connect" }).catch(() => null);
  button.disabled = false;
  if (!answer) {
    say("Connecting did not finish. Try again.", "error");
    return;
  }
  if (!answer.ok) {
    say(answer.message, "error");
    return;
  }
  say(`Connected to ${answer.workspace?.name ?? "your workspace"}.`);
  await showConnected();
});

$("capture-selection").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  // Disabled at once, so a double click sends one capture.
  button.disabled = true;
  let text = "";
  try {
    text = await captureActiveSelection();
  } catch {
    text = "";
  }
  button.disabled = false;
  if (!text.trim()) {
    say("No text is selected on this page. Select the invoice's text, or choose its file.", "error");
    return;
  }
  await captureText(text, button);
});

$("file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    say("Choose a file of at most 4 MB.", "error");
    return;
  }
  input.disabled = true;
  say(`Reading ${file.name}…`);
  try {
    const draft = await captureFile(file, newIdempotencyKey());
    say("");
    await review(draft);
  } catch (error) {
    if (!(await needsConnecting(error))) say(errorText(error), "error");
  } finally {
    input.disabled = false;
  }
});

$("in-tab").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
  window.close();
});

form.addEventListener("input", renderMissing);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  const fields = readForm();
  const problem = amountProblem(fields.amount);
  if (problem) {
    say(problem, "error");
    form.elements.namedItem("amount").focus();
    return;
  }
  const button = $("send");
  button.disabled = true;
  say("Sending…");
  try {
    await saveDraft(current.id, fields);
    const sent = await sendDraft(current.id);
    await chrome.storage.local.remove("currentDraftId");
    say("");
    showSent(sent);
  } catch (error) {
    if (!(await needsConnecting(error))) say(errorText(error), "error");
  } finally {
    button.disabled = false;
  }
});

$("start-over").addEventListener("click", async () => {
  current = null;
  await chrome.storage.local.remove("currentDraftId");
  show("home");
  say("That draft was not sent. Vestiarion deletes it within 7 days.");
});

$("open").addEventListener("click", async () => {
  if (reviewUrl) await chrome.tabs.create({ url: reviewUrl });
});

$("another").addEventListener("click", () => {
  say("");
  show("home");
});

$("disconnect").addEventListener("click", async (event) => {
  // Kept before the await: the event's currentTarget is gone once it has been dispatched.
  const button = event.currentTarget;
  button.disabled = true;
  await disconnect();
  button.disabled = false;
  setWorkspace(null);
  show("connect");
  say("Disconnected. This extension can no longer send drafts.");
});

async function start() {
  await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  const { firstRunDone } = await chrome.storage.local.get("firstRunDone");
  if (!firstRunDone) {
    show("first-run");
    return;
  }
  await showConnected();
}

start().catch(() => say("Something went wrong. Close this and try again.", "error"));
