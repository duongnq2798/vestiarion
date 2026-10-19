import { utcDay } from "../copy";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The two setup reminders (docs/superpowers/specs/2026-10-19-activation-nudge-design.md A4): one to a workspace whose
 * agent has no bill yet, one to a shadow workspace whose agent's decisions wait for a verdict. The look of
 * `actionEmailHtml`, a member's email (no counterparty loop link); every value escaped; no amount, address or wallet.
 */

export interface FirstBillNudge {
  orgName: string;
  /** Whole days since the workspace was opened. */
  days: number;
  shadow: boolean;
  /** The workspace can load sample data and has none (a simulated sandbox). */
  offerSample: boolean;
  links: { addBill: string; console: string };
  origin: string;
}

export interface FirstVerdictNudge {
  orgName: string;
  /** Decisions whose verdict is still to give. */
  waiting: number;
  /** When the agent first decided a real bill, an ISO instant. */
  since: string;
  links: { bills: string };
  origin: string;
}

type Email = { subject: string; html: string; text: string };

const footer = (orgName: string) =>
  `You get this because you can approve payments in ${orgName} and keep its emails on. It is sent once. You can turn these emails off in Settings, under Notifications.`;

const strong = (words: string) => `<strong style="color:#18211c;">${escapeHtml(words)}</strong>`;

const link = (href: string, words: string) => `<a href="${escapeHtml(href)}" target="_blank" style="color:#3048c9;text-decoration:none;">${escapeHtml(words)}</a>`;

export function firstBillNudgeEmail(input: FirstBillNudge): Email {
  const { orgName, days, shadow, offerSample, links, origin } = input;
  const ago = `${days} day${days === 1 ? "" : "s"} ago`;
  const subject = `Give your agent its first bill in ${orgName}`;
  const what = "Give the agent one bill and it decides it within minutes: pay it, schedule it before its due date, or hold it and tell you why. Every decision is signed and explained.";
  const opened = `You opened ${orgName} on Vestiarion ${ago}. ${what}`;
  const shadowLine = "In shadow mode you keep paying your bills as you do now. Add this week's bills and tell the agent whether you agree with each call.";
  const ways = "Three ways to give it one: on Bills, choose New, then Bill to pay; import a list of bills from a CSV or a spreadsheet; or forward bills to the workspace's own address (Settings, under Invoices by email).";
  const sample = "No real bill at hand? Load sample data on the console and watch the agent decide a few sample bills first:";
  const html = actionEmailHtml({
    title: "Give your agent its first bill",
    preheader: `${orgName} has no bill yet. The agent decides one within minutes.`,
    eyebrow: "Getting started",
    heading: "Your agent has no bill to work on yet",
    paragraphsHtml: [
      `You opened ${strong(orgName)} on Vestiarion ${ago}. ${escapeHtml(what)}`,
      ...(shadow ? [escapeHtml(shadowLine)] : []),
      escapeHtml(ways),
      ...(offerSample ? [`No real bill at hand? ${link(links.console, "Load sample data on the console")} and watch the agent decide a few sample bills first.`] : []),
    ],
    button: { label: "Add your first bill", link: links.addBill },
    note: footer(orgName),
    origin,
  });
  const text = [
    opened,
    ...(shadow ? ["", shadowLine] : []),
    "",
    ways,
    ...(offerSample ? ["", sample, links.console] : []),
    "",
    "Add your first bill:",
    links.addBill,
    "",
    footer(orgName),
  ].join("\n");
  return { subject, html, text };
}

export function firstVerdictNudgeEmail(input: FirstVerdictNudge): Email {
  const { orgName, waiting, since, links, origin } = input;
  const decisions = `${waiting} decision${waiting === 1 ? "" : "s"}`;
  const subject = `${decisions} of the agent's ${waiting === 1 ? "waits" : "wait"} for your verdict in ${orgName}`;
  const decided = `In shadow mode you keep paying as you do, and the agent decides each bill beside you. Since ${utcDay(since)} it has decided bills in ${orgName}, and ${decisions} still ${waiting === 1 ? "waits" : "wait"} for you to say whether you agree.`;
  const why = "Agree or disagree with each one, and say why if you like. Your verdicts are the record of how often the agent would have been right, before it pays a real bill for you.";
  const html = actionEmailHtml({
    title: "The agent's decisions wait for your verdict",
    preheader: `Tell the agent whether you agree with its ${decisions} in ${orgName}.`,
    eyebrow: "Shadow mode",
    heading: `${decisions} ${waiting === 1 ? "waits" : "wait"} for your verdict`,
    paragraphsHtml: [
      `In shadow mode you keep paying as you do, and the agent decides each bill beside you. Since ${escapeHtml(utcDay(since))} it has decided bills in ${strong(orgName)}, and ${escapeHtml(decisions)} still ${waiting === 1 ? "waits" : "wait"} for you to say whether you agree.`,
      escapeHtml(why),
    ],
    button: { label: "Give your verdicts", link: links.bills },
    note: footer(orgName),
    origin,
  });
  const text = [decided, "", why, "", "Give your verdicts:", links.bills, "", footer(orgName)].join("\n");
  return { subject, html, text };
}
