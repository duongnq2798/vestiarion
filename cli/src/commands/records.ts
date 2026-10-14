import type {
  Collection,
  Counterparty,
  CounterpartyDetail,
  CreateCounterpartyInput,
  CreateInvoiceInput,
  CreateMilestoneInput,
  Insights,
  Invoice,
  LedgerEntry,
  List,
  Milestone,
  PayeeLink,
  Treasury,
} from "@vestiarion/sdk";
import { Context, PAGE_OPTIONS, WRITE_OPTIONS, type Command } from "../command.js";
import { CliError, EXIT, usageError } from "../errors.js";
import { amountOf, day, orDash, pairs, table, wrap } from "../output.js";

type PageParams = { limit?: number; cursor?: string };

/** `show` reads pages of the API's largest size, and at most this many records, before it stops looking. */
const SHOW_PAGE_SIZE = 200;
const SHOW_MAX_PAGES = 50;
const SHOW_LIMIT = SHOW_PAGE_SIZE * SHOW_MAX_PAGES;

/**
 * Every page from `params.cursor` on. The SDK stops at a cursor the API repeats at once; this also stops at one it
 * gave earlier, so a list that loops back on itself is never read forever.
 */
async function* pagesOf<T, P extends PageParams>(collection: Collection<T, P>, params: P): AsyncGenerator<List<T>> {
  const seen = new Set<string>(params.cursor ? [params.cursor] : []);
  for await (const page of collection.pages(params)) {
    yield page;
    const next = page.page.nextCursor;
    if (!page.page.hasMore || next === null) return;
    if (seen.has(next)) throw new CliError(EXIT.FAILED, "The API gave a page cursor it had already given: stopped rather than read the same pages again.");
    seen.add(next);
  }
}

/** One page, or with `--all` every page from `--cursor` on, as one `{ data, page }`. */
async function readList<T, P extends PageParams>(ctx: Context, collection: Collection<T, P>, filters: Omit<P, keyof PageParams>): Promise<List<T>> {
  const params = { ...filters, limit: ctx.count("limit"), cursor: ctx.string("cursor") } as P;
  if (ctx.values.all !== true) return ctx.call(() => collection.list(params));
  const data: T[] = [];
  await ctx.call(async () => {
    for await (const page of pagesOf(collection, params)) data.push(...page.data);
  });
  return { data, page: { nextCursor: null, hasMore: false, count: data.length } };
}

/**
 * The first item `isIt` picks, read page by page from the start of the list: null once the list ends, or once `isPast`
 * says the item would have come already; "stopped" when SHOW_LIMIT items were read and more remain.
 */
async function search<T, P extends PageParams>(ctx: Context, collection: Collection<T, P>, filters: Omit<P, keyof PageParams>, isIt: (item: T) => boolean, isPast: (item: T) => boolean = () => false): Promise<T | null | "stopped"> {
  return ctx.call(async () => {
    let read = 0;
    for await (const page of pagesOf(collection, { ...filters, limit: SHOW_PAGE_SIZE } as P)) {
      for (const item of page.data) {
        if (isIt(item)) return item;
        if (isPast(item)) return null;
      }
      read += 1;
      if (read >= SHOW_MAX_PAGES && page.page.hasMore) return "stopped" as const;
    }
    return null;
  });
}

/**
 * A record by id, read from its list page by page: these collections have no single-record endpoint. Stops at the
 * first match, or after the SHOW_LIMIT most recent records.
 */
async function findById<T extends { id: string }, P extends PageParams>(ctx: Context, collection: Collection<T, P>, filters: Omit<P, keyof PageParams>, id: string, nouns: [string, string], group: string): Promise<T> {
  const found = await search(ctx, collection, filters, (item) => item.id === id);
  if (found === "stopped") {
    throw new CliError(EXIT.FAILED, `No ${nouns[0]} with id ${id} in the ${SHOW_LIMIT} most recent ${nouns[1]}: show stops looking there. Look further with \`vestiarion ${group} list --all --json\`.`);
  }
  if (!found) throw new CliError(EXIT.FAILED, `No ${nouns[0]} with id ${id} in this workspace.`);
  return found;
}

function listed<T>(list: List<T>, nouns: [string, string], body: (rows: T[]) => string): string {
  const n = list.data.length;
  if (n === 0) return `No ${nouns[1]}${list.page.hasMore ? " on this page" : ""}.\n`;
  let text = body(list.data);
  text += `\n${n} ${n === 1 ? nouns[0] : nouns[1]}`;
  if (list.page.hasMore && list.page.nextCursor) text += `. More: run it again with --cursor ${list.page.nextCursor}, or with --all`;
  return `${text}.\n`;
}

const reasoningBlock = (reasoning: string | null | undefined) => (reasoning ? `\nReasoning\n${wrap(reasoning)}` : "");

// ---- Bills (payables) and invoices (receivables): /api/v1/invoices -------------------------------------------------

const invoiceTable = (rows: Invoice[]) =>
  table(rows, [
    { header: "ID", value: (i) => i.id },
    { header: "STATUS", value: (i) => i.status },
    { header: "AMOUNT", value: (i) => amountOf(i.amount, i.currency) },
    { header: "DUE", value: (i) => day(i.dueDate) },
    { header: "COUNTERPARTY", value: (i) => orDash(i.counterparty?.name), max: 32 },
  ]);

function invoiceDetail(invoice: Invoice, noun: string): string {
  const discount = invoice.earlyPayDiscount ? `${invoice.earlyPayDiscount.percent}% if paid by ${day(invoice.earlyPayDiscount.deadline)}` : null;
  return (
    pairs([
      [noun, invoice.id],
      ["Status", invoice.status],
      ["Amount", amountOf(invoice.amount, invoice.currency)],
      ["Paid", invoice.paidAmount === null ? null : amountOf(invoice.paidAmount, invoice.currency)],
      ["Due", day(invoice.dueDate)],
      ["Counterparty", invoice.counterparty ? `${invoice.counterparty.name} (${invoice.counterparty.riskLevel}) ${invoice.counterparty.id}` : null],
      ["PO", invoice.poReference],
      ["Goods", invoice.direction === "payable" ? (invoice.goodsReceived ? "received" : "not received") : null],
      ["Memo", invoice.memo],
      ["Discount", discount],
      ["Scheduled for", invoice.scheduledFor],
      ["Decided", invoice.decidedAt],
      ["Escalated", invoice.escalatedAt],
      ["Settled", invoice.settledAt],
      ["Transaction", invoice.txHash],
      ["Added", invoice.createdAt],
    ]) + reasoningBlock(invoice.agentReasoning)
  );
}

const STATUS_HELP = "pending, matched, scheduled, paid, held, flagged, awaiting_info, received or rejected";

function invoiceCommands(group: "bills" | "invoices"): Command[] {
  const payable = group === "bills";
  const direction = payable ? "payable" : "receivable";
  const nouns: [string, string] = payable ? ["bill", "bills"] : ["invoice", "invoices"];
  const addVerb = payable ? "add" : "create";
  return [
    {
      path: [group, "list"],
      summary: payable ? "List bills, the payables the business pays, newest first" : "List invoices the business is owed (receivables), newest first",
      description: [`GET /api/v1/invoices?direction=${direction}`],
      options: {
        status: { type: "string", value: "<status>", help: `Only this status: ${STATUS_HELP}` },
        counterparty: { type: "string", value: "<id>", help: "Only this counterparty's" },
        ...PAGE_OPTIONS,
      },
      examples: [`vestiarion ${group} list --status held`],
      async run(ctx) {
        const list = await readList(ctx, ctx.client().invoices, { direction, status: ctx.string("status") as never, counterpartyId: ctx.string("counterparty") });
        return ctx.print(list, (answer) => listed(answer, nouns, invoiceTable));
      },
    },
    {
      path: [group, "show"],
      args: ["<id>"],
      summary: `Show one ${nouns[0]}, with the agent's reasoning`,
      description: [
        `GET /api/v1/invoices?direction=${direction}, page by page until the id is found: the API has no single-invoice endpoint.`,
      ],
      examples: [`vestiarion ${group} show 9440f32c-000d-4a63-97f1-4eb6bf78439f`],
      async run(ctx) {
        const invoice = await findById(ctx, ctx.client().invoices, { direction }, ctx.args[0], nouns, group);
        return ctx.print({ data: invoice }, (answer) => invoiceDetail(answer.data, payable ? "Bill" : "Invoice"));
      },
    },
    {
      path: [group, addVerb],
      summary: payable ? "Add a bill for the agent to decide" : "Add an invoice the business is owed",
      description: [
        `POST /api/v1/invoices with direction ${direction}. Needs a key with write access ("Can also add records").`,
        payable
          ? "The agent decides the bill as it decides one typed into the console, with every guardrail, usually within a minute: within its limits it may pay it. Without --po and --goods-received it asks for the missing detail instead of paying."
          : "Nothing is paid: a receivable is money the business is owed.",
      ],
      options: {
        counterparty: { type: "string", value: "<id>", help: "The counterparty's id, from `vestiarion counterparties list`", required: true },
        amount: { type: "string", value: "<amount>", help: "What it bills, such as 420.00, with at most 6 decimal places", required: true },
        due: { type: "string", value: "<YYYY-MM-DD>", help: "The day it is due", required: true },
        currency: { type: "string", value: "<USDC|EURC>", help: "Defaults to USDC" },
        memo: { type: "string", value: "<text>", help: "What it is for, up to 280 characters" },
        po: { type: "string", value: "<reference>", help: "The purchase order it bills against" },
        ...(payable
          ? {
              "goods-received": { type: "boolean", help: "What it bills for has arrived" },
              "discount-percent": { type: "string", value: "<percent>", help: "An early-payment discount, such as 2" },
              "discount-deadline": { type: "string", value: "<YYYY-MM-DD>", help: "The last day the discount applies" },
            } as const
          : {}),
        ...WRITE_OPTIONS,
      },
      examples: payable
        ? [`vestiarion bills add --counterparty dc5e5751-3287-46c9-8bd1-83a42ab02699 --amount 420.00 --due 2026-10-31 --po PO-4012 --goods-received`]
        : [`vestiarion invoices create --counterparty 4e363b59-d1ca-4425-924c-5c894bc3373f --amount 1250.50 --due 2026-11-15 --memo "October retainer"`],
      async run(ctx) {
        const body: CreateInvoiceInput = { direction, counterpartyId: ctx.need("counterparty"), amount: ctx.need("amount"), dueDate: ctx.need("due") };
        const currency = ctx.string("currency");
        if (currency !== undefined) body.currency = currency as CreateInvoiceInput["currency"];
        if (ctx.string("memo") !== undefined) body.memo = ctx.string("memo");
        if (ctx.string("po") !== undefined) body.poReference = ctx.string("po");
        if (ctx.values["goods-received"] === true) body.goodsReceived = true;
        const percent = ctx.string("discount-percent");
        const deadline = ctx.string("discount-deadline");
        if ((percent === undefined) !== (deadline === undefined)) throw usageError("--discount-percent and --discount-deadline go together.");
        if (percent !== undefined && deadline !== undefined) body.earlyPayDiscount = { percent, deadline };
        const idempotencyKey = ctx.string("idempotency-key");
        await ctx.confirmWrite({
          method: "POST",
          path: "/api/v1/invoices",
          body,
          idempotencyKey,
          then: payable
            ? "The agent decides this bill as it decides one typed into the console, with every guardrail: within its limits it may pay it."
            : "This adds a receivable: nothing is paid.",
        });
        const invoice = await ctx.call(() => ctx.client().invoices.create(body, { idempotencyKey }));
        return ctx.print({ data: invoice }, (answer) =>
          [
            `Added ${nouns[0]} ${answer.data.id}: ${amountOf(answer.data.amount, answer.data.currency)}${answer.data.counterparty ? ` ${payable ? "to" : "from"} ${answer.data.counterparty.name}` : ""}, due ${day(answer.data.dueDate)}, status ${answer.data.status}.`,
            payable ? `Follow the agent's decision: vestiarion bills show ${answer.data.id}` : `See it: vestiarion invoices show ${answer.data.id}`,
            "",
          ].join("\n")
        );
      },
    },
  ];
}

// ---- Counterparties: /api/v1/counterparties ------------------------------------------------------------------------

const counterpartyTable = (rows: Counterparty[]) =>
  table(rows, [
    { header: "ID", value: (c) => c.id },
    { header: "NAME", value: (c) => c.name, max: 32 },
    { header: "ROLE", value: (c) => c.role },
    { header: "RISK", value: (c) => c.riskLevel },
    { header: "LIMIT", value: (c) => (c.paymentLimit === null ? "-" : `${c.paymentLimit} USDC`) },
    { header: "CHAIN", value: (c) => orDash(c.chain) },
  ]);

function counterpartyDetail(c: CounterpartyDetail): string {
  let text = pairs([
    ["Counterparty", c.id],
    ["Name", c.name],
    ["Role", c.role],
    ["Risk", c.riskLevel],
    ["Risk notes", c.riskNotes],
    ["Address", c.address],
    ["Chain", c.chain],
    ["Jurisdiction", c.jurisdiction],
    ["Payment limit", c.paymentLimit === null ? null : `${c.paymentLimit} USDC (baseline ${orDash(c.baselinePaymentLimit)})`],
    ["Performance", c.performanceScore === null ? "no history yet" : String(c.performanceScore)],
    ["Last screened", c.lastScreenedAt],
    ["Added", c.createdAt],
  ]);
  if (c.screeningHistory.length > 0) {
    text += `\nScreenings, newest first\n${table(c.screeningHistory, [
      { header: "WHEN", value: (s) => s.createdAt },
      { header: "RISK", value: (s) => s.riskLevel },
      { header: "MODE", value: (s) => s.screeningMode },
      { header: "STATUS", value: (s) => s.status },
      { header: "SOURCE", value: (s) => s.source, max: 40 },
    ])}`;
  }
  return text;
}

const counterpartyCommands: Command[] = [
  {
    path: ["counterparties", "list"],
    summary: "List vendors, clients and contractors, with their risk tier and payment limit",
    description: ["GET /api/v1/counterparties"],
    options: {
      role: { type: "string", value: "<role>", help: "Only vendor, client or contractor" },
      risk: { type: "string", value: "<tier>", help: "Only unscreened, clear, medium or high" },
      ...PAGE_OPTIONS,
    },
    examples: ["vestiarion counterparties list --role vendor"],
    async run(ctx) {
      const list = await readList(ctx, ctx.client().counterparties, { role: ctx.string("role") as never, riskLevel: ctx.string("risk") as never });
      return ctx.print(list, (answer) => listed(answer, ["counterparty", "counterparties"], counterpartyTable));
    },
  },
  {
    path: ["counterparties", "show"],
    args: ["<id>"],
    summary: "Show one counterparty, with its recent screenings",
    description: ["GET /api/v1/counterparties/{id}"],
    examples: ["vestiarion counterparties show dc5e5751-3287-46c9-8bd1-83a42ab02699"],
    async run(ctx) {
      const counterparty = await ctx.call(() => ctx.client().counterparties.get(ctx.args[0]));
      return ctx.print({ data: counterparty }, (answer) => counterpartyDetail(answer.data));
    },
  },
  {
    path: ["counterparties", "add"],
    summary: "Add a vendor, client or contractor; it is screened as one added in the console",
    description: [
      `POST /api/v1/counterparties. Needs a key with write access ("Can also add records").`,
      "An address added through the API waits for a person in the workspace to confirm it on Counterparties; until then the agent pays nothing to it.",
    ],
    options: {
      name: { type: "string", value: "<name>", help: "2 to 160 characters", required: true },
      role: { type: "string", value: "<role>", help: "vendor or contractor (paid by the business), or client (pays it)", required: true },
      address: { type: "string", value: "<0x…>", help: "Where the agent pays it" },
      chain: { type: "string", value: "<chain>", help: "The chain the address receives on; defaults to the workspace's own" },
      jurisdiction: { type: "string", value: "<text>", help: "Where it is based; screening uses it" },
      "payment-limit": { type: "string", value: "<usdc>", help: "The most the agent pays it at once; required for a vendor or contractor" },
      "notice-email": { type: "string", value: "<email>", help: "Where it is emailed once a payment to it is confirmed" },
      ...WRITE_OPTIONS,
    },
    examples: ['vestiarion counterparties add --name "Quill Studio" --role vendor --address 0x5b2d8c1f0e7a4936b8d1c0e2f3a4b5c6d7e8f901 --payment-limit 500'],
    async run(ctx) {
      const body: CreateCounterpartyInput = { name: ctx.need("name"), role: ctx.need("role") as CreateCounterpartyInput["role"] };
      if (ctx.string("address") !== undefined) body.address = ctx.string("address");
      if (ctx.string("chain") !== undefined) body.chain = ctx.string("chain") as CreateCounterpartyInput["chain"];
      if (ctx.string("jurisdiction") !== undefined) body.jurisdiction = ctx.string("jurisdiction");
      if (ctx.string("payment-limit") !== undefined) body.paymentLimit = ctx.string("payment-limit");
      if (ctx.string("notice-email") !== undefined) body.noticeEmail = ctx.string("notice-email");
      const idempotencyKey = ctx.string("idempotency-key");
      await ctx.confirmWrite({
        method: "POST",
        path: "/api/v1/counterparties",
        body,
        idempotencyKey,
        then: "It is screened as one added in the console. An address waits for a person in the workspace to confirm it before the agent pays to it.",
      });
      const counterparty = await ctx.call(() => ctx.client().counterparties.create(body, { idempotencyKey }));
      return ctx.print({ data: counterparty }, (answer) => {
        const lines = [`Added counterparty ${answer.data.id}: ${answer.data.name}, ${answer.data.role}, risk ${answer.data.riskLevel}.`];
        if (body.address !== undefined) lines.push("Its address waits for a person in the workspace to confirm it on Counterparties.");
        return `${lines.join("\n")}\n`;
      });
    },
  },
];

// ---- Milestones: /api/v1/milestones --------------------------------------------------------------------------------

const milestoneTable = (rows: Milestone[]) =>
  table(rows, [
    { header: "ID", value: (m) => m.id },
    { header: "STATUS", value: (m) => m.status },
    { header: "AMOUNT", value: (m) => amountOf(m.amount) },
    { header: "CONTRACTOR", value: (m) => orDash(m.contractor?.name), max: 28 },
    { header: "TITLE", value: (m) => m.title, max: 40 },
  ]);

function milestoneDetail(m: Milestone): string {
  return (
    pairs([
      ["Milestone", m.id],
      ["Title", m.title],
      ["Status", m.status],
      ["Amount", amountOf(m.amount)],
      ["Contractor", m.contractor ? `${m.contractor.name} (${m.contractor.riskLevel}) ${m.contractor.id}` : null],
      ["Evidence", m.verificationSource],
      ["Verification", `${m.verificationStatus}, by ${m.verificationMethod}`],
      ["Verified", m.verifiedAt],
      ["Decided", m.decidedAt],
      ["Settled", m.settledAt],
      ["Closed", m.closedAt ? `${m.closedAt}${m.closeReason ? `: ${m.closeReason}` : ""}` : null],
      ["Transaction", m.txHash],
      ["Added", m.createdAt],
    ]) + reasoningBlock(m.agentReasoning)
  );
}

const milestoneCommands: Command[] = [
  {
    path: ["milestones", "list"],
    summary: "List contractor milestones, how each was verified, and whether it was paid",
    description: ["GET /api/v1/milestones"],
    options: {
      status: { type: "string", value: "<status>", help: "Only pending, verified, paid, held or closed" },
      contractor: { type: "string", value: "<id>", help: "Only this contractor's" },
      ...PAGE_OPTIONS,
    },
    examples: ["vestiarion milestones list --status pending"],
    async run(ctx) {
      const list = await readList(ctx, ctx.client().milestones, { status: ctx.string("status") as never, contractorId: ctx.string("contractor") });
      return ctx.print(list, (answer) => listed(answer, ["milestone", "milestones"], milestoneTable));
    },
  },
  {
    path: ["milestones", "show"],
    args: ["<id>"],
    summary: "Show one milestone, with the agent's reasoning",
    description: ["GET /api/v1/milestones, page by page until the id is found: the API has no single-milestone endpoint."],
    examples: ["vestiarion milestones show d01b2b49-2ca3-45fe-898c-f2c0128f6188"],
    async run(ctx) {
      const milestone = await findById(ctx, ctx.client().milestones, {}, ctx.args[0], ["milestone", "milestones"], "milestones");
      return ctx.print({ data: milestone }, (answer) => milestoneDetail(answer.data));
    },
  },
  {
    path: ["milestones", "add"],
    summary: "Add a milestone; it is paid only once verified, by GitHub or a person",
    description: [
      `POST /api/v1/milestones. Needs a key with write access ("Can also add records").`,
      "It starts pending. A GitHub pull request as --verification-source is verified by the agent once it is merged; any other link is evidence for the person who verifies it on Contractors. Then the agent decides.",
    ],
    options: {
      contractor: { type: "string", value: "<id>", help: "The contractor's or vendor's id", required: true },
      title: { type: "string", value: "<text>", help: "What was delivered, 3 to 160 characters", required: true },
      amount: { type: "string", value: "<usdc>", help: "What the work is paid, such as 150.00", required: true },
      "verification-source": { type: "string", value: "<https url>", help: "A link to the delivered work, such as a GitHub pull request" },
      ...WRITE_OPTIONS,
    },
    examples: ['vestiarion milestones add --contractor 26d6ffed-356d-474a-8d42-89bc942f6b4e --title "CSV export for EURC" --amount 150.00 --verification-source https://github.com/acme/app/pull/42'],
    async run(ctx) {
      const body: CreateMilestoneInput = { contractorId: ctx.need("contractor"), title: ctx.need("title"), amount: ctx.need("amount") };
      if (ctx.string("verification-source") !== undefined) body.verificationSource = ctx.string("verification-source");
      const idempotencyKey = ctx.string("idempotency-key");
      await ctx.confirmWrite({
        method: "POST",
        path: "/api/v1/milestones",
        body,
        idempotencyKey,
        then: "It starts pending: the agent pays it only once it is verified, by GitHub or by a person, and only after its own checks.",
      });
      const milestone = await ctx.call(() => ctx.client().milestones.create(body, { idempotencyKey }));
      return ctx.print({ data: milestone }, (answer) => `Added milestone ${answer.data.id}: ${answer.data.title}, ${amountOf(answer.data.amount)}, status ${answer.data.status}.\n`);
    },
  },
];

// ---- Payee links: /api/v1/payee-links ------------------------------------------------------------------------------

const payeeLinkCommands: Command[] = [
  {
    path: ["payee-links", "create"],
    summary: "Make a one-time link for a payee to enter the address they are paid at",
    description: [
      `POST /api/v1/payee-links. Needs a key with write access ("Can also add records").`,
      "The link is in this answer only: Vestiarion keeps just its hash. Making one revokes the payee's unused link. The address the payee enters waits for a person in the workspace to confirm it.",
    ],
    options: {
      counterparty: { type: "string", value: "<id>", help: "The vendor's or contractor's id", required: true },
      yes: WRITE_OPTIONS.yes,
    },
    examples: ["vestiarion payee-links create --counterparty 26d6ffed-356d-474a-8d42-89bc942f6b4e"],
    async run(ctx) {
      const body = { counterpartyId: ctx.need("counterparty") };
      await ctx.confirmWrite({
        method: "POST",
        path: "/api/v1/payee-links",
        body,
        idempotencyKey: null,
        then: "This revokes the payee's unused link, if they have one. The address they enter waits for a person to confirm it.",
      });
      const link = await ctx.call(() => ctx.client().payeeLinks.create(body));
      return ctx.print({ data: link }, (answer: { data: PayeeLink }) =>
        [`Payee link for ${answer.data.counterpartyId}, until ${answer.data.expiresAt}:`, answer.data.url, "Send it to the payee yourself: it is shown only this once.", ""].join("\n")
      );
    },
  },
];

// ---- The agent's decisions and the ledger: /api/v1/ledger ----------------------------------------------------------

/** Why the agent decided as it did, where an entry records it. */
function reasoningOf(entry: LedgerEntry): string | null {
  const detail = entry.detail as { decision?: { reasoning?: unknown }; reasoning?: unknown };
  const reasoning = detail.decision?.reasoning ?? detail.reasoning;
  return typeof reasoning === "string" ? reasoning : null;
}

const decisionBlocks = (rows: LedgerEntry[]) =>
  rows
    .map((entry) => {
      const reasoning = reasoningOf(entry);
      return `#${entry.seq}  ${entry.ts}  ${entry.action}\n${wrap(entry.summary)}${reasoning ? wrap(`Why: ${reasoning}`) : ""}`;
    })
    .join("\n");

const ledgerTable = (rows: LedgerEntry[]) =>
  table(rows, [
    { header: "SEQ", value: (e) => String(e.seq) },
    { header: "TIME", value: (e) => e.ts.slice(0, 19).replace("T", " ") },
    { header: "ACTOR", value: (e) => e.actor },
    { header: "ACTION", value: (e) => e.action, max: 28 },
    { header: "SUMMARY", value: (e) => e.summary, max: 72 },
  ]);

const decisionCommands: Command[] = [
  {
    path: ["decisions", "list"],
    summary: "List the agent's decisions, oldest first, with its reasoning",
    description: [
      "GET /api/v1/ledger?actor=agent: every entry the agent signed into the workspace's ledger, oldest first, as the API pages it.",
      "Store the last page's next cursor and pass it as --cursor to read only what is new.",
    ],
    options: { domain: { type: "string", value: "<domain>", help: "Only this domain, such as ap, ar or treasury" }, ...PAGE_OPTIONS },
    examples: ["vestiarion decisions list --domain ap --all"],
    async run(ctx) {
      const list = await readList(ctx, ctx.client().ledger, { actor: "agent", domain: ctx.string("domain") });
      return ctx.print(list, (answer) => listed(answer, ["decision", "decisions"], decisionBlocks));
    },
  },
  {
    path: ["decisions", "show"],
    args: ["<seq>"],
    summary: "Show one decision: its summary, reasoning and the whole signed entry",
    description: ["GET /api/v1/ledger?actor=agent, page by page until the entry is found: the API has no single-entry endpoint."],
    examples: ["vestiarion decisions show 1042"],
    async run(ctx) {
      const raw = ctx.args[0].replace(/^#/, "");
      if (!/^\d+$/.test(raw)) throw usageError("<seq> is the entry's number in the ledger, such as 1042.");
      const seq = Number(raw);
      // Oldest first: past the number, it is not there.
      const entry = await search(ctx, ctx.client().ledger, { actor: "agent" }, (item) => item.seq === seq, (item) => item.seq > seq);
      if (entry === "stopped") {
        throw new CliError(EXIT.FAILED, `The agent's first ${SHOW_LIMIT} ledger entries hold no entry ${seq}: show stops looking there. Look further with \`vestiarion decisions list --all --json\`.`);
      }
      if (!entry) throw new CliError(EXIT.FAILED, `The agent wrote no ledger entry ${seq} in this workspace.`);
      return ctx.print({ data: entry }, (answer) =>
        pairs([
          ["Entry", `#${answer.data.seq}`],
          ["Time", answer.data.ts],
          ["Action", `${answer.data.domain} ${answer.data.action}`],
          ["Summary", answer.data.summary],
          ["Hash", answer.data.hash],
          ["Signed by", answer.data.signingKeyId ?? "a key from before key ids"],
        ]) +
          reasoningBlock(reasoningOf(answer.data)) +
          `\nDetail\n${JSON.stringify(answer.data.detail, null, 2)}\n`
      );
    },
  },
];

const ledgerCommands: Command[] = [
  {
    path: ["ledger", "list"],
    summary: "List the workspace's signed audit chain, oldest first",
    description: ["GET /api/v1/ledger. Each entry carries its hashes and signature, for checking it yourself (--json)."],
    options: {
      domain: { type: "string", value: "<domain>", help: "Only this domain" },
      actor: { type: "string", value: "<actor>", help: "Only entries written by agent, human or system" },
      ...PAGE_OPTIONS,
    },
    examples: ["vestiarion ledger list --actor human --limit 20"],
    async run(ctx) {
      const list = await readList(ctx, ctx.client().ledger, { domain: ctx.string("domain"), actor: ctx.string("actor") });
      return ctx.print(list, (answer) => listed(answer, ["entry", "entries"], ledgerTable));
    },
  },
  {
    path: ["ledger", "check"],
    summary: "Ask the API to replay the workspace's chain: signatures, body hashes and links",
    description: [
      "GET /api/v1/ledger/verify. Exits 0 when the chain verified, and 2 when it is broken or could not be checked.",
      "To check a downloaded export without trusting the API, use `vestiarion ledger verify <export.json>`.",
    ],
    async run(ctx) {
      const verification = await ctx.call(() => ctx.client().ledger.verify());
      ctx.print({ data: verification }, (answer) => {
        const v = answer.data;
        const head =
          v.valid === true
            ? `VALID: ${v.checkedEntries} entries checked, each signed and linked.`
            : v.valid === false
              ? `BROKEN at entry #${v.brokenAt ?? "?"}: ${v.reason ?? "the chain does not verify."} (${v.checkedEntries} entries checked)`
              : `NOT CHECKED: ${v.reason ?? "the API gave no verdict."}`;
        return [head, ...(v.warnings ?? []).map((warning) => `Warning: ${warning}`), ""].join("\n");
      });
      return verification.valid === true ? EXIT.OK : EXIT.FAILED;
    },
  },
];

// ---- Treasury and insights -----------------------------------------------------------------------------------------

const percent = (rate: number) => `${Number((rate * 100).toFixed(4))}%`;

function treasuryText(t: Treasury): string {
  let text = `Accounts\n${table(t.accounts, [
    { header: "NAME", value: (a) => a.name, max: 32 },
    { header: "KIND", value: (a) => a.kind },
    { header: "CHAIN", value: (a) => a.chain },
    { header: "BALANCE", value: (a) => `${a.balance} ${a.token}` },
    { header: "APY", value: (a) => percent(a.apy) },
  ])}\n`;
  const f = t.latestForecast;
  text += pairs([
    ["Reserve position", String(t.reservePosition)],
    ["Due within 7 days", t.obligations.dueWithin7Days === null ? "not known before the first cycle" : `${t.obligations.dueWithin7Days} (as of ${t.obligations.asOf})`],
    ["Due within 14 days", t.obligations.dueWithin14Days === null ? null : String(t.obligations.dueWithin14Days)],
    ["Forecast", f ? `${f.horizonDays} days from ${f.asOf}: in ${f.projectedInflow}, out ${f.projectedOutflow}, liquid ${f.liquidBalance}` : "none yet"],
    ["Recommendation", f?.recommendation],
  ]);
  if (t.recentActions.length > 0) {
    text += `\nRecent treasury moves, newest first\n${table(t.recentActions, [
      { header: "WHEN", value: (a) => a.createdAt },
      { header: "ACTION", value: (a) => a.action },
      { header: "AMOUNT", value: (a) => String(a.amount) },
      { header: "REASONING", value: (a) => orDash(a.reasoning), max: 60 },
    ])}`;
  }
  return text;
}

function insightsText(i: Insights): string {
  const run = i.runs[i.runs.length - 1];
  const transfer = i.transfers[i.transfers.length - 1];
  return (
    pairs([
      ["Cycle runs", run ? `${i.runs.length}; latest ${run.status} at ${run.finishedAt}: ${run.decisionCount} decisions, ${run.paidCount} paid, ${run.heldCount} held, ${run.flaggedCount} flagged` : "none"],
      ["Transfers", transfer ? `${i.transfers.length}; latest ${transfer.status} at ${transfer.executedAt} on ${transfer.chain} (${transfer.providerMode})` : "none"],
      ["Snapshots", String(i.snapshots.length)],
      ["Treasury moves", String(i.treasuryMoves.length)],
      ["Screenings", String(i.screenings.length)],
    ]) + "Every record: vestiarion insights --json\n"
  );
}

const treasuryCommands: Command[] = [
  {
    path: ["treasury"],
    summary: "The workspace's accounts, reserve, obligations and latest forecast",
    description: ["GET /api/v1/treasury"],
    async run(ctx) {
      const treasury = await ctx.call(() => ctx.client().treasury.get());
      return ctx.print({ data: treasury }, (answer) => treasuryText(answer.data));
    },
  },
  {
    path: ["insights"],
    summary: "The latest transfers, cycle runs, snapshots, treasury moves and screenings",
    description: ["GET /api/v1/insights. The text is a summary; --json has every record."],
    async run(ctx) {
      const insights = await ctx.call(() => ctx.client().insights.get());
      return ctx.print({ data: insights }, (answer) => insightsText(answer.data));
    },
  },
];

export const RECORD_COMMANDS: Command[] = [
  ...invoiceCommands("bills"),
  ...invoiceCommands("invoices"),
  ...counterpartyCommands,
  ...milestoneCommands,
  ...payeeLinkCommands,
  ...decisionCommands,
  ...ledgerCommands,
  ...treasuryCommands,
];
