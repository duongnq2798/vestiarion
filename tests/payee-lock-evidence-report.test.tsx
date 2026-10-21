import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayeeLockEvidenceView, periodWords, utc } from "@/components/PayeeLockEvidenceView";
import { payeeLockEvidence, type CheckedEntry } from "@/lib/payee-lock-evidence";
import { evidencePeriodFrom, PAYEE_LOCK_CSV_FIELDS, payeeLockEvidenceCsv, payeeLockQuestions, QUESTIONS_NOTE, viaWords, whoWords } from "@/lib/payee-lock-evidence-report";
import { takeEvidencePageToken } from "@/lib/rate-limit";

/**
 * The payee lock's evidence pack read for people (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md
 * EP7-EP10): the answers to the questions insurers ask, counted from the pack; the CSV, one row per change and safe in
 * a spreadsheet; and the page, laid out to print. The entries follow the Oct 20 runs on Arc testnet.
 */

const OWNER = "63a43a55-78f9-4b85-907a-eea1483a06af";
const APPROVER = "9b1c2d3e-0000-4000-8000-00000000a002";
const NORTHWIND = "28e7be97-df37-4b15-9d43-be8a330f6ece";
const WARDROBE = "33d27523-47ff-4750-9a2b-0797cbd6a855";
const INVOICE = "0a12c729-a618-43fc-bded-e04ef1bf9037";
const NEW = "0xa8a4ced0cda82b24d11e0386f066eb8c27fd4887";
const OLD = "0xc4c24e3a6bd02ed99ffce7595a9227349a7f05e4";
const TX = "0x49787501b6738cc2653bfb93a51293d4f036ff85a41115dc7f5b5f07db720551";

function entry(seq: number, ts: string, action: string, detail: Record<string, unknown>, ok: boolean | null = true): CheckedEntry {
  return {
    seq,
    id: `e-${seq}`,
    ts,
    actor: "human",
    domain: action.startsWith("counterparty") ? "compliance" : "ap",
    action,
    summary: action,
    detail,
    body_hash: `b${seq}`,
    signature: `s${seq}`,
    prev_hash: `p${seq}`,
    hash: `h${seq}`,
    signing_key_id: "k1",
    check: ok === true ? { ok: true } : ok === false ? { ok: false, reason: "bad" } : { ok: null, reason: "unknown key" },
  } as CheckedEntry;
}

/** Northwind: a second member's call-back, held twice, paid after the wait. Wardrobe: changed by a formula, unconfirmed. */
const entries: CheckedEntry[] = [
  entry(4839, "2026-10-20T11:14:02Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: OLD, to: NEW, chain: "ARC-TESTNET" }),
  entry(4843, "2026-10-20T11:15:17Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, guardrailRule: "counterparty.address_unconfirmed", execution: { txRef: null, resultingStatus: "held" } }),
  entry(4863, "2026-10-20T12:10:52Z", "counterparty_address_confirmed", {
    by: APPROVER,
    counterpartyId: NORTHWIND,
    address: NEW,
    via: "confirm",
    verification: { method: "call", contact: "=HYPERLINK(\"http://evil.test\")", contactOnFileBefore: true, note: "Second member confirms." },
    payeeLock: { coolingHours: 4 },
  }),
  entry(4866, "2026-10-20T12:11:00Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, guardrailRule: "counterparty.cooling_off", execution: { txRef: null, resultingStatus: "held" } }),
  entry(4919, "2026-10-20T15:16:07Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, amountPaid: 3, currency: "USDC", execution: { txRef: TX, resultingStatus: "paid" } }, null),
  entry(4950, "2026-10-20T18:00:00Z", "counterparty_address_changed", { via: "payee_link", linkId: "l1", counterpartyId: WARDROBE, from: null, to: OLD }),
];

const pack = payeeLockEvidence({
  workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" },
  network: "arc-testnet",
  period: { from: "2026-10-20", to: "2026-10-20" },
  lock: { on: true, coolingHours: 4 },
  entries,
  counterparties: new Map([
    [NORTHWIND, "Northwind Referrals"],
    [WARDROBE, "+Wardrobe, \"Holdings\""],
  ]),
  members: new Map([
    [OWNER, "owner@pinecrest.test"],
    [APPROVER, "approver@pinecrest.test"],
  ]),
  keys: [{ id: "k1", status: "active", publicKeyPem: "-----BEGIN PUBLIC KEY-----" }],
  now: new Date("2026-10-21T08:00:00Z"),
});

describe("who did a step, in words", () => {
  it("names a member, a former member, the payee, GitHub or nobody known", () => {
    expect(whoWords({ kind: "member", email: "a@b.test" })).toBe("a@b.test");
    expect(whoWords({ kind: "former_member", id: "1a2b3c4d" })).toBe("a former member (1a2b3c4d)");
    expect(whoWords({ kind: "payee_link", linkId: "l1" })).toBe("the payee, through a payee link");
    expect(whoWords({ kind: "github", login: "octo" })).toBe("GitHub (octo)");
    expect(whoWords({ kind: "unknown" })).toBe("unknown");
    expect(viaWords("confirm")).toBe("Confirm address");
    expect(viaWords("approval")).toBe("approving a payment to it");
    expect(viaWords(null)).toBe("not recorded");
  });
});

describe("what the records answer to insurers' questions (EP8)", () => {
  const answers = Object.fromEntries(payeeLockQuestions(pack).map((item) => [item.id, item]));

  it("asks the seven controls, each in our own words", () => {
    expect(Object.keys(answers)).toEqual(["callback", "second_person", "record", "hold", "wait", "lookalike", "independent"]);
    for (const item of Object.values(answers)) expect(item.question.endsWith("?")).toBe(true);
  });

  it("counts the changes' own records: one confirmed with a call-back by a second person, held, then paid after the wait", () => {
    expect(answers.callback).toMatchObject({
      answer: "yes",
      evidence: "1 of 1 confirmation recorded a call or a message to a contact the person confirming marked as on file before the change.",
    });
    expect(answers.second_person).toMatchObject({ answer: "yes", evidence: "1 of 1 confirmation came from someone other than whoever entered the address." });
    expect(answers.record.answer).toBe("yes");
    expect(answers.hold).toMatchObject({ answer: "yes", evidence: "1 of 1 first payment to these addresses came after the address was confirmed, and the agent held 2 payments for them." });
    expect(answers.wait).toMatchObject({ answer: "yes", evidence: "1 of 1 first payment to these addresses came after a payee lock wait recorded with its confirmation had ended." });
    expect(answers.lookalike).toMatchObject({ answer: "yes", evidence: "1 of 1 confirmation went through Confirm address, which checks for lookalikes before anyone confirms; it warned on 0." });
    // One cited entry's key is not known here, so not every entry is verified.
    expect(answers.independent).toMatchObject({ answer: "partly", evidence: "5 of 6 ledger entries this pack cites verified against the workspace's keys." });
  });

  it("answers from the records, never today's setting, which only the how line names", () => {
    const off = payeeLockQuestions({ ...pack, lock: { ...pack.lock, now: { on: false, coolingHours: 0 } } });
    const answer = (id: string) => off.find((item) => item.id === id)!;
    expect(answer("wait").answer).toBe("yes");
    expect(answer("callback").answer).toBe("yes");
    expect(answer("callback").how).toMatch(/^Now the payee lock is off\./);
    expect(answers.wait.how).toMatch(/^Now the payee lock is on, with a 4-hour wait\./);
  });

  it("has nothing to show for a period without a change, rather than a yes, whatever the lock is set to now", () => {
    const empty = payeeLockQuestions({ ...pack, changes: [], entries: [] });
    for (const item of empty) expect(item.answer, item.id).toBe("not_seen");
  });

  const [northwind] = pack.changes;
  const ask = (rows: (typeof pack)["changes"]) => Object.fromEntries(payeeLockQuestions({ ...pack, changes: rows }).map((item) => [item.id, item.answer]));

  it("answers partly or no when some or none of the confirmations had the check", () => {
    const solo = { ...northwind, checks: { ...northwind.checks, secondPerson: false, contactOnFileBefore: false } };
    expect(ask([northwind, solo]).second_person).toBe("partly");
    expect(ask([solo]).callback).toBe("no");
  });

  it("counts a check in person as no call-back, even with its contact marked as on file before", () => {
    const inPerson = { ...northwind, confirmation: { ...northwind.confirmation!, record: { ...northwind.confirmation!.record!, method: "in_person" as const } } };
    expect(ask([inPerson]).callback).toBe("no");
  });

  it("counts a payment made with no wait recorded against the wait, though the lock waits now", () => {
    const noWait = { ...northwind, checks: { ...northwind.checks, paidAfterWait: null } };
    expect(ask([northwind, noWait]).wait).toBe("partly");
    expect(ask([noWait]).wait).toBe("no");
  });

  it("answers the hold from holds alone when nothing was paid", () => {
    expect(ask([{ ...northwind, firstPayment: null, checks: { ...northwind.checks, paidAfterConfirmation: null, paidAfterWait: null } }]).hold).toBe("yes");
  });

  it("does not count a confirmation by approving, which shows no lookalike warning", () => {
    const approved = { ...northwind, confirmation: { ...northwind.confirmation!, via: "approval" } };
    expect(ask([northwind, approved]).lookalike).toBe("partly");
    expect(ask([approved]).lookalike).toBe("no");
  });
});

describe("the page's period and limit (EP7)", () => {
  const NOW = new Date("2026-10-21T08:00:00Z");

  it("opens on the last 30 days, shows all time when asked, and reads from and to as the file does", () => {
    expect(evidencePeriodFrom({}, NOW)).toEqual({ period: { from: "2026-09-22", to: "2026-10-21" }, unreadable: false });
    expect(evidencePeriodFrom({ from: "", to: "" }, NOW)).toEqual({ period: { from: "2026-09-22", to: "2026-10-21" }, unreadable: false });
    expect(evidencePeriodFrom({ all: "1" }, NOW)).toEqual({ period: { from: null, to: null }, unreadable: false });
    expect(evidencePeriodFrom({ from: "2026-10-01" }, NOW)).toEqual({ period: { from: "2026-10-01", to: null }, unreadable: false });
  });

  it("shows the last 30 days and says so for a day it cannot read or a value given twice", () => {
    expect(evidencePeriodFrom({ from: "2026-13-01" }, NOW)).toEqual({ period: { from: "2026-09-22", to: "2026-10-21" }, unreadable: true });
    expect(evidencePeriodFrom({ from: ["2026-10-01", "2026-10-02"] }, NOW).unreadable).toBe(true);
    expect(evidencePeriodFrom({ all: ["1", "1"] }, NOW).unreadable).toBe(true);
  });

  it("lets a member read the page twenty times at once, then once every 3 seconds", () => {
    const at = 5_000_000_000_000;
    const member = "evidence-page-member";
    const reads = Array.from({ length: 21 }, () => takeEvidencePageToken(member, at));
    expect(reads.slice(0, 20).every(Boolean)).toBe(true);
    expect(reads[20]).toBe(false);
    expect(takeEvidencePageToken(member, at + 3_000)).toBe(true);
  });
});

describe("the CSV (EP9)", () => {
  const csv = payeeLockEvidenceCsv(pack);
  const lines = csv.slice(1).trimEnd().split("\r\n");

  it("starts with a byte-order mark and the columns, then one row per change", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(lines[0]).toBe(PAYEE_LOCK_CSV_FIELDS.join(","));
    expect(lines).toHaveLength(3);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes a change's facts, its checks as yes or no, and the entries it rests on", () => {
    const row = lines[1];
    for (const part of ["Northwind Referrals", OLD, NEW, "owner@pinecrest.test", "approver@pinecrest.test", "Called them on a number we had before", TX, "agent", "4839", "4863", "4843 4866", "4919"]) {
      expect(row, part).toContain(part);
    }
    expect(row).toContain("counterparty.address_unconfirmed x1; counterparty.cooling_off x1");
    expect(row).toContain(",yes,yes,4839,");
  });

  it("keeps a value that starts like a formula from running, and quotes commas and quotes", () => {
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
    expect(lines[2].startsWith(`"'+Wardrobe, ""Holdings"""`)).toBe(true);
    expect(lines[2]).toContain("the payee, through a payee link");
  });
});

describe("the page (EP7, EP10)", () => {
  const presets = [
    { label: "Last 30 days", period: { from: "2026-09-22", to: "2026-10-21" } },
    { label: "All time", period: { from: null, to: null } },
  ];
  const markup = renderToStaticMarkup(<PayeeLockEvidenceView pack={pack} questions={payeeLockQuestions(pack)} slug="pinecrest-studio" presets={presets} />);
  const text = markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

  it("shows the lock, the counts, the questions and every change with its entries", () => {
    expect(text).toContain("Now the payee lock is on, with a 4-hour wait after an address changes.");
    expect(text).toContain(QUESTIONS_NOTE);
    expect(text).toContain("by approver@pinecrest.test, with Confirm address");
    // The transaction itself, so a printed copy keeps it.
    expect(text).toContain(TX);
    expect(text).toContain("Address changes 2");
    expect(text).toContain("What insurers ask, and what these records show");
    expect(text).toContain("each insurer words its own");
    expect(text).toContain("Northwind Referrals");
    expect(text).toContain("Not confirmed");
    expect(text).toContain("#4839 #4863 #4843 #4866 #4919");
    expect(text).toContain("5 of 6 signed ledger entries this pack cites verified");
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/${TX}"`);
  });

  it("downloads the period's CSV and signed JSON, prints, and keeps its controls out of the print", () => {
    expect(markup).toContain('href="/api/evidence/payee-lock?org=pinecrest-studio&amp;from=2026-10-20&amp;to=2026-10-20&amp;format=csv"');
    expect(markup).toContain('href="/api/evidence/payee-lock?org=pinecrest-studio&amp;from=2026-10-20&amp;to=2026-10-20"');
    expect(text).toContain("Print or save as PDF");
    expect(markup).toMatch(/<div class="flex flex-col gap-4 print:hidden"><form[^>]*method="get"/);
    // The printed page says what it is.
    expect(markup).toContain("hidden text-sm text-ink-2 print:block");
    expect(text).toContain("Vestiarion payee lock evidence · Pinecrest Studio (Arc testnet) · 2026-10-20 to 2026-10-20 · read 2026-10-21 08:00 UTC");
    expect(markup).toContain('href="?from=2026-09-22&amp;to=2026-10-21"');
    expect(markup).toContain('href="?all=1"');
  });

  it("writes times and periods without ambiguity", () => {
    expect(utc("2026-10-20T11:14:02Z")).toBe("2026-10-20 11:14 UTC");
    expect(periodWords({ from: null, to: null })).toBe("all time");
    expect(periodWords({ from: "2026-10-01", to: null })).toBe("from 2026-10-01");
  });

  it("says so when no address changed in the period", () => {
    const empty = renderToStaticMarkup(<PayeeLockEvidenceView pack={{ ...pack, changes: [] }} questions={[]} slug="pinecrest-studio" presets={presets} />);
    expect(empty).toContain("No payout address changed in this period");
  });
});
