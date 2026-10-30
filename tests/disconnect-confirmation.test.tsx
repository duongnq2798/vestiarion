// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AsanaPanelView } from "@/lib/asana/views";
import type { CrmPanelView } from "@/lib/connectors/crm-review";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import type { StatusView } from "@/lib/connectors/status";
import type { GitHubInstallation } from "@/lib/github/installs";
import type { LinearPanelView } from "@/lib/linear/views";
import type { SlackPanelView } from "@/lib/slack/panel";

/**
 * Disconnecting an integration says it worked (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md).
 * Each of these actions revalidates the page before it answers, so its answer and the page without its button land in
 * one render. The toast is raised by the action itself (DC1): here the page drops the button while the action still
 * runs, and the answer raises the toast all the same. A refusal revalidates nothing: it stays beside the button and
 * raises no toast (DC3). The source scan keeps every disconnect form wrapped, or held by a component on a pinned list of
 * components the page keeps mounted (DC2, DC6).
 */

const { toastMock, actions } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  actions: {
    asana: { disconnectAsanaAction: vi.fn(), syncAsanaNowAction: vi.fn() },
    linear: { disconnectLinearAction: vi.fn(), syncLinearNowAction: vi.fn() },
    accounting: { disconnectAccountingAction: vi.fn(), syncAccountingNowAction: vi.fn(), loadAccountingAccountsAction: vi.fn(), chooseAccountingAccountAction: vi.fn() },
    hubspot: { disconnectHubSpotAction: vi.fn(), syncHubSpotNowAction: vi.fn(), setHubSpotReceiptsAction: vi.fn() },
    pipedrive: { disconnectPipedriveAction: vi.fn(), syncPipedriveNowAction: vi.fn(), setPipedriveReceiptsAction: vi.fn() },
    zohocrm: { disconnectZohoCrmAction: vi.fn(), syncZohoCrmNowAction: vi.fn() },
    slack: { disconnectSlackAccountAction: vi.fn(), removeSlackAction: vi.fn(), setSlackDecisionsLimitAction: vi.fn() },
    github: { disconnectGitHubAction: vi.fn() },
    extension: { disconnectExtensionAction: vi.fn() },
  },
}));
vi.mock("@/components/ui/Toaster", () => ({ toast: toastMock }));
vi.mock("@/app/actions/asana", () => actions.asana);
vi.mock("@/app/actions/linear", () => actions.linear);
vi.mock("@/app/actions/accounting", () => actions.accounting);
vi.mock("@/app/actions/hubspot", () => actions.hubspot);
vi.mock("@/app/actions/pipedrive", () => actions.pipedrive);
vi.mock("@/app/actions/zohocrm", () => actions.zohocrm);
vi.mock("@/app/actions/slack", () => actions.slack);
vi.mock("@/app/actions/github", () => actions.github);
vi.mock("@/app/actions/extension", () => actions.extension);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

import AccountingPanel from "@/components/AccountingPanel";
import AsanaPanel from "@/components/AsanaPanel";
import ChromeExtensionPanel, { type ConnectionView } from "@/components/ChromeExtensionPanel";
import GitHubPanel from "@/components/GitHubPanel";
import HubSpotPanel from "@/components/HubSpotPanel";
import LinearPanel from "@/components/LinearPanel";
import PipedrivePanel from "@/components/PipedrivePanel";
import SlackPanel from "@/components/SlackPanel";
import ZohoCrmPanel from "@/components/ZohoCrmPanel";

const status = (revoked: boolean, name: string): StatusView =>
  revoked ? { tone: "off", title: `Disconnected from ${name}`, detail: [], reconnect: false } : { tone: "ok", title: `Connected to ${name}`, detail: [], reconnect: false };

const asana = (revoked: boolean): AsanaPanelView => ({
  state: "connection",
  status: status(revoked, "Olivia's Asana"),
  connected: !revoked,
  revoked,
  counts: { linked: 0, ready: 0, accepted: 0, held: 0 },
  figures: { manualChecks: 0, disputes: 0, timeToProposal: null, window: "the last 30 days" },
});

const linear = (revoked: boolean): LinearPanelView => ({
  state: "connection",
  status: status(revoked, "the Northstar workspace in Linear"),
  connected: !revoked,
  revoked,
  workspaceName: "Northstar",
  counts: { linked: 0, ready: 0, accepted: 0, held: 0 },
  figures: { manualChecks: 0, disputes: 0, timeToProposal: null, window: "the last 30 days" },
});

const books = (revoked: boolean): AccountingPanelView => ({
  state: "connection",
  connectionId: "conn-books",
  status: status(revoked, "Demo Company"),
  connected: !revoked,
  revoked,
  organisation: "Demo Company",
  waiting: 0,
  closedAfterAdded: 0,
  paymentAccount: null,
  sample: null,
});

const crm = (revoked: boolean): CrmPanelView => ({
  state: "connection",
  connectionId: "conn-crm",
  status: status(revoked, "Northstar Studio"),
  connected: !revoked,
  revoked,
  organisation: "Northstar Studio",
  toPlan: 0,
  changed: 0,
});

const slack = (youConnected: boolean): SlackPanelView => ({
  installed: true,
  teamName: "Acme HQ",
  channelName: "finance",
  installedAt: "2026-10-03T08:00:00Z",
  decisionsLimitUsdc: null,
  youConnected,
  canReadFiles: true,
});

const ACME: GitHubInstallation = { installationId: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", connectedAt: "2026-10-04T08:00:00Z" };
const EXTENSION: ConnectionView = {
  id: "0b6f6c1e-5b8a-4c39-9a51-2f1d8e7c4a10",
  member: null,
  mine: true,
  client: "abcdefghijklmnopabcdefghijklmnop",
  connectedAt: "2026-10-15T09:00:00Z",
  lastUsedAt: null,
};

interface Case {
  name: string;
  action: Mock;
  button: string;
  message: string;
  /** The card while connected, and the card the revalidated page draws once the action has disconnected it. */
  before: ReactElement;
  after: ReactElement;
}

const books3 = (provider: "xero" | "quickbooks" | "zohobooks", label: string): Case => ({
  name: label,
  action: actions.accounting.disconnectAccountingAction,
  button: `Disconnect ${label}`,
  message: `${label} is disconnected. Bills already added stay in Vestiarion.`,
  before: <AccountingPanel provider={provider} orgSlug="acme" view={books(false)} canManage notice={null} />,
  after: <AccountingPanel provider={provider} orgSlug="acme" view={books(true)} canManage notice={null} />,
});

const CASES: Case[] = [
  {
    name: "Asana",
    action: actions.asana.disconnectAsanaAction,
    button: "Disconnect Asana",
    message: "Asana is disconnected. Acceptances already recorded stay in Vestiarion.",
    before: <AsanaPanel orgSlug="acme" view={asana(false)} canManage notice={null} />,
    after: <AsanaPanel orgSlug="acme" view={asana(true)} canManage notice={null} />,
  },
  {
    name: "Linear",
    action: actions.linear.disconnectLinearAction,
    button: "Disconnect Linear",
    message: "Linear is disconnected. Acceptances already recorded stay in Vestiarion.",
    before: <LinearPanel orgSlug="acme" view={linear(false)} canManage notice={null} />,
    after: <LinearPanel orgSlug="acme" view={linear(true)} canManage notice={null} />,
  },
  books3("xero", "Xero"),
  books3("quickbooks", "QuickBooks"),
  books3("zohobooks", "Zoho Books"),
  {
    name: "HubSpot",
    action: actions.hubspot.disconnectHubSpotAction,
    button: "Disconnect HubSpot",
    message: "HubSpot is disconnected. Deals already planned stay in Vestiarion.",
    before: <HubSpotPanel orgSlug="acme" view={crm(false)} canManage notice={null} />,
    after: <HubSpotPanel orgSlug="acme" view={crm(true)} canManage notice={null} />,
  },
  {
    name: "Pipedrive",
    action: actions.pipedrive.disconnectPipedriveAction,
    button: "Disconnect Pipedrive",
    message: "Pipedrive is disconnected. Deals already planned stay in Vestiarion.",
    before: <PipedrivePanel orgSlug="acme" view={crm(false)} canManage notice={null} />,
    after: <PipedrivePanel orgSlug="acme" view={crm(true)} canManage notice={null} />,
  },
  {
    name: "Zoho CRM",
    action: actions.zohocrm.disconnectZohoCrmAction,
    button: "Disconnect Zoho CRM",
    message: "Zoho CRM is disconnected. Deals already planned stay in Vestiarion.",
    before: <ZohoCrmPanel orgSlug="acme" view={crm(false)} canManage notice={null} />,
    after: <ZohoCrmPanel orgSlug="acme" view={crm(true)} canManage notice={null} />,
  },
  {
    name: "Slack, a member's own account",
    action: actions.slack.disconnectSlackAccountAction,
    button: "Disconnect my account",
    message: "Your Slack account is disconnected.",
    before: <SlackPanel orgSlug="acme" view={slack(true)} canManage canAdminister={false} notice={null} />,
    after: <SlackPanel orgSlug="acme" view={slack(false)} canManage canAdminister={false} notice={null} />,
  },
  {
    name: "Slack, the workspace",
    action: actions.slack.removeSlackAction,
    button: "Remove Slack",
    message: "Slack is disconnected. The agent's decisions no longer go there.",
    before: <SlackPanel orgSlug="acme" view={slack(false)} canManage canAdminister={false} notice={null} />,
    after: <SlackPanel orgSlug="acme" view={{ installed: false }} canManage canAdminister={false} notice={null} />,
  },
  {
    name: "GitHub, an account's row",
    action: actions.github.disconnectGitHubAction,
    button: "Disconnect",
    message: "GitHub is disconnected from this workspace. To take the app's access away, uninstall it on GitHub.",
    before: <GitHubPanel orgSlug="acme" installations={[ACME]} canManage notice={null} network="arc-testnet" />,
    after: <GitHubPanel orgSlug="acme" installations={[]} canManage notice={null} network="arc-testnet" />,
  },
  {
    name: "Chrome extension, an extension's row",
    action: actions.extension.disconnectExtensionAction,
    button: "Disconnect",
    message: "Disconnected. That extension can no longer send drafts.",
    before: <ChromeExtensionPanel orgSlug="acme" available connections={[EXTENSION]} seesEveryone={false} />,
    after: <ChromeExtensionPanel orgSlug="acme" available connections={[]} seesEveryone={false} />,
  },
];

const REFUSED = "That did not work. Try again in a moment.";

let container: HTMLDivElement;
let root: Root;

const show = (card: ReactElement) => act(() => root.render(card));
const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

/** An answer the test gives when it chooses, so the page can change first. */
function later<T>() {
  let give!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    give = resolve;
  });
  return { promise, give };
}

describe.each(CASES)("$name: $button (disconnect confirmation DC1, DC3)", ({ action, button, message, before, after }) => {
  it("raises the action's answer as a toast, though the page dropped the button before it answered", async () => {
    const answer = later<{ ok: boolean; message: string }>();
    action.mockReturnValue(answer.promise);
    show(before);
    await press(button);
    expect(action).toHaveBeenCalledTimes(1);

    // The revalidated page: the card is disconnected and the button is gone, with the answer still to come.
    show(after);
    expect(buttons()).not.toContain(button);
    await act(async () => answer.give({ ok: true, message }));

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith(message);
  });

  it("shows a refusal beside the button, and raises no toast", async () => {
    action.mockResolvedValue({ ok: false, message: REFUSED });
    show(before);
    await press(button);

    expect(buttons()).toContain(button);
    expect(container.querySelector(".text-refused")?.textContent).toContain(REFUSED);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

const COMPONENTS = path.join(process.cwd(), "src", "components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

interface FormCall {
  file: string;
  /** The component or hook that holds the form: the one declared nearest above the call, at the top of the file. */
  holder: string;
  /** The first argument: the action, or the name it was wrapped under. */
  action: string;
  /** The arguments after it, options included. */
  rest: string;
}

/** A declaration at the top of a file: `function Name`, `export default function Name`, `const Name =` and the like. */
const DECLARATION = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm;

/** The name declared nearest above `index` at the top of the file, which is the component or hook a call there is in. */
function holderAt(text: string, index: number): string {
  let name = "";
  for (const match of text.slice(0, index).matchAll(DECLARATION)) name = match[1] ?? match[2];
  return name;
}

/** Every `useActionForm(…)` call in a source, read up to its closing parenthesis. */
function formCalls(file: string, text: string): FormCall[] {
  return [...text.matchAll(/useActionForm(?:<[^<>()]*>)?\(/g)].map((match) => {
    const open = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = open;
    while (end < text.length && depth > 0) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")") depth -= 1;
      end += 1;
    }
    const args = text.slice(open, end - 1);
    const comma = args.indexOf(",");
    return {
      file: path.relative(process.cwd(), file).split(path.sep).join("/"),
      holder: holderAt(text, match.index ?? 0),
      action: (comma < 0 ? args : args.slice(0, comma)).trim(),
      rest: comma < 0 ? "" : args.slice(comma + 1),
    };
  });
}

/** An integration's disconnect: `disconnect…Action`, and Remove Slack and Remove Discord, those integrations' own. */
const DISCONNECT = /^(?:disconnect\w+|removeSlack|removeDiscord)Action$/;
const TOAST_ON_SUCCESS = /\btoastOnSuccess\s*(?::(?!\s*false\b)|[,}])/;
/** `toast.success` called in the form's own `onSuccess` or `onResult`, which run in the same effect as `toastOnSuccess`. */
const TOAST_SUCCESS_CALL = /\btoast\.success\(/;

/** Whether a form's options raise a success toast from the component that holds it. */
const raisesOwnToast = (call: FormCall) => TOAST_ON_SUCCESS.test(call.rest) || TOAST_SUCCESS_CALL.test(call.rest);

/**
 * The disconnect forms that raise their own success toast (`toastOnSuccess`, or `toast.success` in their callbacks), as
 * `file holder: action`, however the form's result is named.
 */
function ownToasts(calls: FormCall[]): string[] {
  return calls.filter((call) => DISCONNECT.test(call.action) && raisesOwnToast(call)).map((call) => `${call.file} ${call.holder}: ${call.action}`);
}

/**
 * The disconnect forms that may raise their own success toast (DC2, DC6), each keyed by the component that holds it:
 * that component was read and found to be one the page keeps mounted when the disconnect answers, so the effect that
 * raises the toast still runs. The list is pinned: a form joins it only by an edit here, once its holder is known to
 * stay mounted. Moving a listed form into another component, such as a child drawn only while connected, changes its
 * key and fails the scan, and so does a listed form that stops raising its own toast. Anything else uses
 * `withSuccessToast` (DC1).
 */
const KEPT_MOUNTED: Record<string, string> = {
  "src/components/DiscordPanel.tsx DiscordPanel: removeDiscordAction":
    "DiscordPanel holds the form and hands it to its Disconnect; Settings draws the panel whether or not Discord is connected.",
  "src/components/TelegramCard.tsx TelegramCard: disconnectTelegramAction":
    "TelegramCard holds and draws the form; Notifications draws the card whether or not a chat is linked, and the card only swaps its connected view for Connect.",
};

describe("disconnect forms in src/components (disconnect confirmation DC2, DC6)", () => {
  const sources = tsxFiles(COMPONENTS).map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const calls = sources.flatMap(({ file, text }) => formCalls(file, text));
  // The actions wrapped at module scope, as `const disconnect = withSuccessToast(disconnectAsanaAction)`.
  const wrapped = sources.flatMap(({ text }) => [...text.matchAll(/const\s+\w+\s*=\s*withSuccessToast\((\w+)\)/g)].map((match) => match[1]));

  it("reads the forms it guards", () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(calls.filter((call) => DISCONNECT.test(call.action)).map((call) => call.file)).toEqual(
      expect.arrayContaining(["src/components/DiscordPanel.tsx", "src/components/TelegramCard.tsx", "src/components/GoogleSheetsPanel.tsx"])
    );
    // Every form is put down to the component or hook that holds it, so the pinned list names a holder, not a file.
    expect(calls.filter((call) => !/^(?:[A-Z]\w*|use[A-Z]\w*)$/.test(call.holder)).map((call) => `${call.file}: ${call.action}`)).toEqual([]);
  });

  it("wraps each disconnect whose card drops its button in withSuccessToast (DC1)", () => {
    expect(wrapped).toEqual(
      expect.arrayContaining([
        "disconnectAsanaAction",
        "disconnectLinearAction",
        "disconnectAccountingAction",
        "disconnectHubSpotAction",
        "disconnectPipedriveAction",
        "disconnectZohoCrmAction",
        "disconnectSlackAccountAction",
        "removeSlackAction",
        "disconnectGitHubAction",
        "disconnectExtensionAction",
      ])
    );
  });

  it("never raises a success toast twice: a form wrapped in withSuccessToast raises none of its own (DC2)", () => {
    const twice = sources.flatMap(({ file, text }) => {
      const names = new Set([...text.matchAll(/const\s+(\w+)\s*=\s*withSuccessToast\(/g)].map((match) => match[1]));
      return formCalls(file, text)
        .filter((call) => (names.has(call.action) || call.action.startsWith("withSuccessToast(")) && raisesOwnToast(call))
        .map((call) => `${call.file}: ${call.action}`);
    });
    expect(twice).toEqual([]);
  });

  it("finds a disconnect form that raises its own success toast, however the form's result is named and whichever component holds it (DC6)", () => {
    const source = [
      "const disconnect = withSuccessToast(disconnectWrappedAction);",
      "",
      "export default function ExamplePanel() {",
      "  const form = useActionForm(disconnectExampleAction, INITIAL, { toastOnSuccess: true });",
      "  const { state, formProps } = useActionForm(removeSlackAction, INITIAL, { resetOnSuccess: true, toastOnSuccess });",
      "  const quiet = useActionForm(disconnectQuietAction, INITIAL, { toastOnSuccess: false });",
      "  const wrapped = useActionForm(disconnect, INITIAL);",
      "  const told = useActionForm(disconnectToldAction, INITIAL, { onSuccess: (result) => toast.success(result.message) });",
      "  const refused = useActionForm(disconnectRefusedAction, INITIAL, { onResult: (result) => { if (!result.ok) toast.error(result.message); } });",
      "}",
      "",
      // The bug this guards against: the form moved into the part of the card the page drops once it is disconnected.
      "function Disconnect({ orgSlug }: { orgSlug: string }) {",
      "  const { state, pending, formProps } = useActionForm(removeDiscordAction, INITIAL, { toastOnSuccess: true });",
      "}",
      "",
      "export const Connected = ({ orgSlug }: { orgSlug: string }) => {",
      "  const leave = useActionForm(disconnectTelegramAction, INITIAL, { toastOnSuccess: true });",
      "};",
    ].join("\n");
    const found = ownToasts(formCalls(path.join(COMPONENTS, "Example.tsx"), source));
    expect(found).toEqual([
      "src/components/Example.tsx ExamplePanel: disconnectExampleAction",
      "src/components/Example.tsx ExamplePanel: removeSlackAction",
      "src/components/Example.tsx ExamplePanel: disconnectToldAction",
      "src/components/Example.tsx Disconnect: removeDiscordAction",
      "src/components/Example.tsx Connected: disconnectTelegramAction",
    ]);
    // Moved into a child, a listed action is reported under the child's name, which the pinned list does not hold.
    expect(found.filter((key) => key in KEPT_MOUNTED)).toEqual([]);
  });

  it("lets a disconnect form raise its own success toast only where its holding component is listed as one the page keeps mounted (DC2, DC6)", () => {
    expect(ownToasts(calls).sort()).toEqual(Object.keys(KEPT_MOUNTED).sort());
  });
});
