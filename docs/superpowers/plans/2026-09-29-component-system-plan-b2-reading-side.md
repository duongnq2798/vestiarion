# Component system — Plan B2: the reading side, page chrome and consistency tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything a person reads in a workspace — decision cards, treasury tiles, the audit ledger and cycle report, provenance, charts' chrome and the pages around them — onto the primitives in `src/components/ui/`, render the domain components on `/design` from fixtures, and add the tests that keep every future screen on the system.

**Architecture:** Domain components in `src/components/vx/` are rebuilt from `ui/` primitives (`Card`, `Badge`, `Callout`, `Eyebrow`, `SectionHeader`, `EmptyState`, `Disclosure`, `Table`, `CopyButton`, `Button`, chips) without changing their props, so pages keep compiling task by task. Pages then drop the deprecated `vx` wrappers; a final task deletes the wrappers and the old CSS utilities and adds `tests/ui-consistency.test.ts`, which scans the source for raw controls, colour literals, off-scale radii and removed utilities. The agent's run control (`AgentControlsClient`) already moved in #27 and is not part of this plan; the approvals inbox and pause control from #25 were built on the primitives. Before this plan starts, the only offences the Task 10 patterns find are in files Tasks 1, 2, 4, 5 and 8 rewrite (checked at `7e7e85d`). `next/link` renders in the node test environment without a router (checked), so the tests below can assert on its `<a>`.

**Tech Stack:** Next.js 16.3 (App Router), React 19.2, Tailwind 4.3, radix-ui 1.6, lucide-react, Vitest 5 (node environment, `renderToStaticMarkup` contract tests).

**Spec:** `docs/superpowers/specs/2026-09-28-component-system-design.md` — §6 (screens), §8 (enforcement), §9 (`/design`), §13 rulings P1–P13 (P10: this plan is B2).

## Global Constraints

- Work only in `E:\APP2028\hackathon-project-ui`, branch `feat/component-reading` (from `7e7e85d`, main after #27). Never run commands in `E:\APP2028\hackathon-project`. Never open or print `.env.local`.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). Every `/o/[slug]` page keeps awaiting `params`, calling `requireMembership`, `export const dynamic = "force-dynamic"`, loading inside `inOrg`, and rendering `<PageHead title={sectionTitle("<key>")}` (pinned by `tests/access-gates.test.ts` and `tests/navigation.test.ts`).
- No new dependencies. `npm run verify` is green at every commit.
- Import primitives directly from `@/components/ui/<Name>`. Outside `src/components/ui/`, render no raw `<button>`, `<select>`, `<textarea>`, or non-hidden `<input>`.
- Colours only from the brand tokens (`bg-agent`, `text-ink-3`, `border-line`, … with `/opacity`, or `var(--color-…)` strings for SVG); no hex/`rgb()`/`hsl()`/`oklch()` literals in `.tsx`; no Tailwind default palette; no `white`/`black` utilities.
- Radius by role: `rounded-md` tags, chips, `Kbd`, inline code; `rounded-lg` menu and list items, `sm` controls; `rounded-xl` `md`/`lg` buttons and fields, callouts, code blocks and panels inside a card; `rounded-2xl` cards and dialogs; `rounded-full` pills, dots, bars and avatars. No `rounded`, `rounded-sm`, `rounded-3xl` or arbitrary radii outside `ui/`.
- Shadows only `shadow-control|surface|raised|overlay|brand`, and `drop-shadow-logo` for the logo. No arbitrary `shadow-[…]`. Task 10 deletes the `surface-shadow`, `brand-shadow` and `logo-shadow` utilities.
- Hover and press `duration-150 ease-standard`; `m.*` components only.
- A component that is a Server Component today stays one; client primitives (`CopyButton`, `Tooltip`) may be rendered inside it.
- Tone is never the only signal: badges and callouts carry a word or an icon.
- Feedback: success that keeps the person on the page → toast; an error → inline, never only a toast.
- The React Compiler lint rules are errors (no synchronous `setState` in an effect body, no `ref.current` read during render).
- JSX text uses typographic apostrophes and quotes (’ “ ”). Copy stays as it is; an empty view may gain a short title where `EmptyState` needs one, split from its existing sentence where possible.
- Commit messages describe the change plainly and end with the implementing model's `Co-Authored-By` trailer.

## Review Focus

1. **A decision card with no evidence, no transaction and no audit entry shows no empty footer; a refused one still says “no transaction sent” and shows the rule it broke.** Pinned by Task 2's tests.
2. **The copy buttons in an audit row copy the full hash, previous hash, body hash and signature — not the shortened display — and a long value wraps inside its row on a phone.** Pinned by Task 4's tests (full `value`, `break-all`) and Task 12's 375px check.
3. **The domain filter says which filter is in force to a screen reader (`aria-current="page"`), “All” when none is.** Pinned by Task 4's tests.
4. **A chart with no measurements shows an empty state inside its card, and provenance is said in words (LIVE, SIMULATED, MIXED).** Pinned by Task 8's tests.
5. **A ledger check that never reached a verdict (network down, no key) says “Not checked” in the neutral tone — never “broken”.** Pinned by Task 5's tests of `verificationVerdict`.

---

### Task 1: Domain primitives on the design system

**Files:**
- Modify: `src/components/vx/Primitives.tsx`, `src/components/vx/Provenance.tsx`, `src/components/vx/PerformanceHistory.tsx`, `src/components/vx/Glyphs.tsx`
- Test: create `tests/vx-display.test.tsx`

**Interfaces:**
- Consumes: `Badge`, `BadgeProps` (`@/components/ui/Badge`), `cn`, `Disclosure`.
- Produces (unchanged signatures): `fmt(value)`, `Money({ value, token?, sign?, simulated?, struck?, className? })`, `OutcomeBadge({ outcome, label? })`, `ModeBadge({ mode? })`, `Hash({ value, href?, className? })`, `explorerTx(hash)`, `Reasoning({ text, className? })`, `ProvenanceBar({ legs, compact? })`, `ProvenanceLeg`, `PerformanceHistory({ score, inputs, compact? })`. New: `shortHash(value): string`. Kept for now and deleted in Task 10: `Label`, `Card`, `SectionHead` in `Primitives.tsx`.

- [ ] **Step 1: Write the failing tests** — `tests/vx-display.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { Hash, ModeBadge, OutcomeBadge, Reasoning, shortHash } from "@/components/vx/Primitives";
import { ProvenanceBar } from "@/components/vx/Provenance";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("OutcomeBadge", () => {
  it.each([
    ["settled", "Settled on Arc", "text-proof"],
    ["held", "Held for you", "text-held"],
    ["refused", "Refused by guardrail", "text-refused"],
    ["simulated", "Simulated", "hatch"],
    ["scheduled", "Scheduled", "text-ink-2"],
    ["recorded", "Recorded", "text-ink-2"],
  ] as const)("says %s in words, with its glyph and tone", (outcome, word, toneClass) => {
    const markup = html(<OutcomeBadge outcome={outcome} />);
    expect(markup).toContain(word);
    expect(markup).toContain(toneClass);
    expect(markup).toContain("<svg");
  });

  it("uses the caller’s label when there is one", () => {
    expect(html(<OutcomeBadge outcome="held" label="Awaiting an approver" />)).toContain("Awaiting an approver");
  });
});

describe("ModeBadge", () => {
  it("renders nothing without a mode", () => {
    expect(html(<ModeBadge />)).toBe("");
  });

  it("names the decision mode", () => {
    expect(html(<ModeBadge mode="llm" />)).toContain(">llm</span>");
  });
});

describe("Hash", () => {
  const value = "0x1234567890abcdef1234567890abcdef";

  it("shortens a long value and keeps all of it in the title", () => {
    expect(shortHash(value)).toBe("0x1234…cdef");
    const markup = html(<Hash value={value} />);
    expect(markup).toContain("0x1234…cdef");
    expect(markup).toContain(`title="${value}"`);
  });

  it("leaves a short value whole", () => {
    expect(shortHash("0xabc")).toBe("0xabc");
  });

  it("says a link opens a new tab", () => {
    const markup = html(<Hash value={value} href="https://testnet.arcscan.app/tx/0x1" />);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("opens in a new tab");
  });

  it("lets the caller colour a plain hash", () => {
    expect(html(<Hash value={value} className="text-ink-2" />)).toContain("text-ink-2");
    expect(html(<Hash value={value} className="text-ink-2" />)).not.toContain("text-ink-3");
  });
});

describe("Reasoning", () => {
  it("marks the facts a reader checks: invoice numbers, amounts and days", () => {
    const markup = html(<Reasoning text="Paid INV-204 for 1,250.00 USDC on day 26." />);
    expect(markup.match(/<span class="[^"]*font-mono/g)).toHaveLength(3);
    expect(markup).not.toContain("rounded-sm");
  });
});

describe("ProvenanceBar", () => {
  const legs = [
    { label: "Payments", detail: "Arc testnet", live: true },
    { label: "Yield", detail: "USYC reserve", live: false },
  ];

  it("says live or simulated in words for every leg", () => {
    const markup = html(<ProvenanceBar legs={legs} />);
    expect(markup).toContain('aria-label="Live and simulated product capabilities"');
    expect(markup).toContain(">Live</span>");
    expect(markup).toContain(">Simulated</span>");
  });

  it("hides each leg’s detail below md when compact", () => {
    expect(html(<ProvenanceBar legs={legs} compact />)).toContain("hidden md:inline");
  });

  it("uses no old shadow utility", () => {
    expect(html(<ProvenanceBar legs={legs} />)).not.toContain("surface-shadow");
  });
});

describe("PerformanceHistory", () => {
  it("keeps the score inputs in a closed disclosure", () => {
    const markup = html(<PerformanceHistory score={0.9} inputs={null} />);
    expect(markup).toContain("Performance history · 90.0% clean");
    expect(markup).toMatch(/<details class="[^"]*disclosure/);
    expect(markup).not.toMatch(/<details[^>]* open=""/);
  });

  it("says there is no history without a score", () => {
    expect(html(<PerformanceHistory score={null} inputs={null} />)).toContain("No history yet");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/vx-display.test.tsx`
Expected: FAIL — `shortHash` is not exported, the Hash link has no “opens in a new tab”, Reasoning uses `rounded-sm`, PerformanceHistory's `<details>` has no `disclosure` class.

- [ ] **Step 3: Rewrite `src/components/vx/Primitives.tsx`**

```tsx
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { OutcomeGlyph } from "./Glyphs";
import type { Outcome } from "./types";

export function fmt(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

export function Money({
  value,
  token = "USDC",
  sign,
  simulated,
  struck,
  className,
}: {
  value: number;
  token?: string;
  sign?: "+" | "−";
  simulated?: boolean;
  struck?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      <span className={cn(simulated && "underline decoration-dashed decoration-ink-3 underline-offset-4", struck && "line-through decoration-refused decoration-2")}>
        {sign && <span className="mr-0.5 text-ink-3">{sign}</span>}
        {fmt(Math.abs(value))}
      </span>
      <span className="ml-1 text-[0.72em] font-medium tracking-wide text-ink-3">{token}</span>
    </span>
  );
}

const OUTCOMES: Record<Outcome, { word: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  settled: { word: "Settled on Arc", tone: "proof" },
  scheduled: { word: "Scheduled", tone: "neutral" },
  recorded: { word: "Recorded", tone: "neutral" },
  held: { word: "Held for you", tone: "held" },
  refused: { word: "Refused by guardrail", tone: "refused" },
  simulated: { word: "Simulated", tone: "simulated" },
};

/** What happened to a decision, in words and in its tone, with the outcome's own glyph. */
export function OutcomeBadge({ outcome, label }: { outcome: Outcome; label?: string }) {
  const item = OUTCOMES[outcome];
  return (
    <Badge tone={item.tone} icon={<OutcomeGlyph outcome={outcome} />}>
      {label ?? item.word}
    </Badge>
  );
}

/** Which engine decided: the model, or the rule-based fallback. */
export function ModeBadge({ mode }: { mode?: string }) {
  if (!mode) return null;
  return (
    <Badge tone="agent" size="sm" className="font-mono uppercase tracking-wide">
      {mode}
    </Badge>
  );
}

export function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** A hash, shortened for reading; the full value is in the title, and a link opens the explorer in a new tab. */
export function Hash({ value, href, className }: { value: string; href?: string; className?: string }) {
  const short = shortHash(value);
  return href ? (
    <a
      href={href}
      title={value}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 font-mono text-xs tabular-nums text-proof transition-colors duration-150 ease-standard hover:underline", className)}
    >
      <span>{short}</span>
      <ArrowUpRight aria-hidden className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  ) : (
    <span title={value} className={cn("inline-flex items-center gap-1 font-mono text-xs tabular-nums text-ink-3", className)}>
      {short}
    </span>
  );
}

export const explorerTx = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

const FACT = /(\b[a-z]+-pr#\d+\b|\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USYC)\b|\bPO[-#]?[A-Z0-9-]+\b|\bINV[-#]?[A-Z0-9-]+\b|\b0x[0-9a-fA-F]{6,}\b|\b\d+(?:\.\d+)?%|\bday \d+\b|#\d+\b)/gi;

/** The agent's reasoning in the serif face, with the facts a reader checks set in mono. */
export function Reasoning({ text, className }: { text: string; className?: string }) {
  const parts = text.split(FACT);
  return (
    <p className={cn("max-w-[70ch] text-pretty font-serif text-reasoning text-ink", className)}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={`${part}-${index}`} className="rounded-md bg-raised px-1 font-mono text-[0.84em] text-ink">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </p>
  );
}

/** @deprecated Import `Eyebrow` from `@/components/ui/Eyebrow`. Deleted in Plan B2 Task 10. */
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3 ${className}`}>
      {children}
    </span>
  );
}

/** @deprecated Import `Card` from `@/components/ui/Card`. Deleted in Plan B2 Task 10. */
export function Card({
  children,
  className = "",
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  tone?: "default" | "refused" | "held" | "simulated";
}) {
  const toneClass = {
    default: "border-line bg-surface",
    refused: "border-refused-line bg-surface",
    held: "border-held-line bg-surface",
    simulated: "border-dashed border-line-strong bg-surface",
  }[tone];
  return <section className={`surface-shadow rounded-xl border ${toneClass} ${className}`}>{children}</section>;
}

/** @deprecated Import `SectionHeader` from `@/components/ui/SectionHeader`. Deleted in Plan B2 Task 10. */
export function SectionHead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        {meta && <span className="text-[0.8125rem] text-ink-3">{meta}</span>}
      </div>
      {action}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `src/components/vx/Provenance.tsx`**

```tsx
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";

export interface ProvenanceLeg {
  label: string;
  detail: string;
  live: boolean;
}

/**
 * What is live and what is simulated, one badge per leg, each saying so in
 * words. `compact` is for the status strip above every workspace page: smaller
 * badges, and each leg's detail only where there is room for it, so on a phone
 * the three legs share two lines instead of taking three.
 */
export function ProvenanceBar({ legs, compact = false }: { legs: ProvenanceLeg[]; compact?: boolean }) {
  return (
    <ul aria-label="Live and simulated product capabilities" className={cn("flex flex-wrap", compact ? "gap-1.5" : "gap-2")}>
      {legs.map((leg) => (
        <li key={leg.label}>
          <Badge
            tone={leg.live ? "proof" : "simulated"}
            size={compact ? "sm" : "md"}
            dot
            className={cn("gap-2 font-medium text-ink", compact ? "text-xs" : "text-[0.8125rem]")}
          >
            <span>
              {leg.label}{" "}
              <span className={cn("font-normal text-ink-2", compact && "hidden md:inline")}>· {leg.detail}</span>
            </span>
            <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", leg.live ? "text-proof" : "text-ink-2")}>
              {leg.live ? "Live" : "Simulated"}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Rewrite `src/components/vx/PerformanceHistory.tsx`**

```tsx
import { Disclosure } from "@/components/ui/Disclosure";
import { emptyCounterpartyHistory, type CounterpartyHistoryInputs } from "@/lib/agent/counterparty-history";

export function PerformanceHistory({
  score,
  inputs,
  compact = false,
}: {
  score: number | null;
  inputs: CounterpartyHistoryInputs | null;
  compact?: boolean;
}) {
  const facts = inputs ?? emptyCounterpartyHistory();
  const label = score == null ? "No history yet" : `${(score * 100).toFixed(1)}% clean`;

  return (
    <div className={compact ? "mt-2" : "mt-3"}>
      <p className="text-xs font-medium text-ink">Performance history · {label}</p>
      <Disclosure
        variant="bare"
        summary="Score inputs"
        className="mt-1 text-xs text-ink-3"
        summaryClassName="w-fit transition-colors duration-150 ease-standard hover:text-ink-2"
      >
        <p className="mt-1 max-w-md leading-relaxed">
          {facts.paidWithoutIntervention} clean payment(s) · {facts.informationRequested} information
          request(s) · {facts.heldOrFlagged} held/flagged · {facts.duplicateSubmissions} confirmed
          duplicate(s) · {facts.riskTierChanges} risk-tier change(s)
        </p>
        {/* Shown separately and outside the score, because a reviewer needs to
            see the holds that were deliberately not counted. Otherwise a
            counterparty with three held invoices and an unchanged score looks
            like a bug rather than a decision. */}
        {facts.heldByOurPolicy > 0 && (
          <p className="mt-1 max-w-md leading-relaxed">
            Not scored: {facts.heldByOurPolicy} hold(s) caused by our own payment limit or risk tier,
            which say nothing about how this counterparty behaves.
          </p>
        )}
        <p className="mt-1 max-w-md leading-relaxed">
          Pulled toward 50% until there is enough history to leave it, so a single outcome cannot
          read as a verdict. Evidence for closer review, never a payment guardrail.
        </p>
      </Disclosure>
    </div>
  );
}
```

- [ ] **Step 6: Delete the unused generic glyphs**

In `src/components/vx/Glyphs.tsx`, delete the functions `NavGlyph`, `MenuGlyph`, `CloseGlyph`, `SelectorGlyph`, `SignOutGlyph` and `PlusGlyph`, and the `import type { NavKey } from "./nav";` line that only `NavGlyph` used. Keep `DOMAINS`, `DOMAIN_CODE`, `DOMAIN_NAME`, `DomainGlyph`, `OutcomeGlyph`, and — until their callers move in Tasks 2–4 — `ShieldGlyph`, `ArrowGlyph`, `ChevronGlyph`, `CheckGlyph`, `CrossGlyph`.

Run: `grep -rn "NavGlyph\|MenuGlyph\|CloseGlyph\|SelectorGlyph\|SignOutGlyph\|PlusGlyph" src tests`
Expected: no output.

- [ ] **Step 7: Run the tests and the full check**

Run: `npx vitest run tests/vx-display.test.tsx` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/components/vx/Primitives.tsx src/components/vx/Provenance.tsx src/components/vx/PerformanceHistory.tsx src/components/vx/Glyphs.tsx tests/vx-display.test.tsx
git commit -m "feat(ui): outcome, mode and provenance badges from the design system

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 2: The decision card

**Files:**
- Modify: `src/components/vx/DecisionCard.tsx`, `src/components/vx/Glyphs.tsx`
- Test: create `tests/decision-card.test.tsx`

**Interfaces:**
- Consumes: Task 1's `OutcomeBadge`, `ModeBadge`, `Money`, `Hash`, `Reasoning`, `explorerTx`, `fmt`; `Card`, `Callout`, `Badge`, `Eyebrow`, `cn`.
- Produces: `DecisionCard({ decision, compact?, orgSlug })` — unchanged.

- [ ] **Step 1: Write the failing tests** — `tests/decision-card.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import type { Decision } from "@/components/vx/types";

const html = (node: ReactElement) => renderToStaticMarkup(node);

const base: Decision = {
  id: "d1",
  domain: "ap",
  action: "Paid",
  subject: "INV-204 to Northwind Supply",
  outcome: "settled",
  amount: 1250,
  reasoning: "Paid INV-204 for 1,250.00 USDC because the purchase order matched.",
  evidence: [],
  at: "2026-09-29T10:15:00Z",
};

describe("DecisionCard", () => {
  it("is one article in the card's tone", () => {
    const markup = html(<DecisionCard decision={base} orgSlug="acme" />);
    expect(markup).toMatch(/^<article class="[^"]*rounded-2xl/);
    expect(markup).toContain("Settled on Arc");
  });

  it("has no footer without evidence, a transaction or an audit entry", () => {
    expect(html(<DecisionCard decision={base} orgSlug="acme" />)).not.toContain("<footer");
  });

  it("links its audit entry and its transaction", () => {
    const markup = html(<DecisionCard decision={{ ...base, auditSeq: 42, txHash: `0x${"ab".repeat(32)}` }} orgSlug="acme" />);
    expect(markup).toContain('href="/o/acme/audit#seq-42"');
    expect(markup).toContain("audit #0042");
    expect(markup).toContain("https://testnet.arcscan.app/tx/0x");
  });

  it("shows the rule a refused decision broke, and says nothing was sent", () => {
    const refused: Decision = {
      ...base,
      action: "Pay",
      outcome: "refused",
      amount: 9000,
      guardrail: { rule: "payment_limit", attempted: 9000, limit: 5000, note: "new vendor" },
      auditSeq: 7,
    };
    const markup = html(<DecisionCard decision={refused} orgSlug="acme" />);
    expect(markup).toContain("Blocked by code, not by the model");
    expect(markup).toContain("payment_limit");
    expect(markup).toContain("Tried to");
    expect(markup).toContain("no transaction sent");
    expect(markup).toContain("line-through");
    // A refusal listed on a page is standing information, not something that just went wrong.
    expect(markup).not.toContain('role="alert"');
  });

  it("marks missing evidence in the held tone and keeps its value", () => {
    const markup = html(<DecisionCard decision={{ ...base, evidence: [{ label: "PO", value: "PO-7", state: "missing" }] }} orgSlug="acme" />);
    expect(markup).toContain('aria-label="Evidence cited by this decision"');
    expect(markup).toContain("text-held");
    expect(markup).toContain("PO-7");
  });

  it("opens linked evidence in a new tab", () => {
    const markup = html(<DecisionCard decision={{ ...base, evidence: [{ label: "PR", value: "acme-pr#12", href: "https://github.com/acme/pull/12", state: "ok" }] }} orgSlug="acme" />);
    expect(markup).toContain('href="https://github.com/acme/pull/12"');
    expect(markup).toContain('target="_blank"');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/decision-card.test.tsx`
Expected: FAIL — the card is a `<section>` with `rounded-xl`, and the guardrail band has `role="alert"`.

- [ ] **Step 3: Rewrite `src/components/vx/DecisionCard.tsx`**

```tsx
import { ArrowUpRight, Check, ShieldX, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import { DOMAIN_NAME, DomainGlyph } from "./Glyphs";
import { explorerTx, fmt, Hash, ModeBadge, Money, OutcomeBadge, Reasoning } from "./Primitives";
import type { Decision, Evidence, Guardrail, Outcome } from "./types";

const CARD_TONE: Partial<Record<Outcome, "refused" | "held" | "simulated">> = {
  refused: "refused",
  held: "held",
  simulated: "simulated",
};

/** One decision the agent made: what, how much, why, and the evidence and receipts behind it. */
export function DecisionCard({ decision, compact = false, orgSlug }: { decision: Decision; compact?: boolean; orgSlug: string }) {
  const refused = decision.outcome === "refused";
  const time = new Date(decision.at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const hasFooter = decision.evidence.length > 0 || Boolean(decision.txHash) || decision.auditSeq != null;

  return (
    <Card asChild tone={CARD_TONE[decision.outcome] ?? "default"} className="overflow-hidden">
      <article>
        <header className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-ink-3">
              <DomainGlyph domain={decision.domain} className="size-3" />
              <Eyebrow>
                {DOMAIN_NAME[decision.domain]} · {time} UTC
              </Eyebrow>
              <ModeBadge mode={decision.decisionMode} />
            </div>
            <h3 className="mt-1.5 text-base font-semibold leading-snug text-ink">
              {refused && <span className="font-normal text-ink-3">Tried to </span>}
              {refused ? decision.action.toLowerCase() : decision.action} {decision.subject}
            </h3>
            {decision.memo && <p className="mt-0.5 text-sm text-ink-2">{decision.memo}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
            {decision.amount != null && (
              <Money
                value={decision.amount}
                token={decision.token}
                struck={refused}
                simulated={decision.outcome === "simulated"}
                className={cn("text-xl font-semibold", refused ? "text-ink-3" : "text-ink")}
              />
            )}
            <OutcomeBadge outcome={decision.outcome} label={decision.outcomeLabel} />
          </div>
        </header>

        {refused && decision.guardrail && <GuardrailBand guardrail={decision.guardrail} token={decision.token} action={decision.action.toLowerCase()} />}

        <div className={compact ? "px-4 pb-3 pt-3 sm:px-5" : "px-4 pb-4 pt-4 sm:px-5"}>
          <Eyebrow className="text-agent">{refused ? "What the agent argued" : "Agent’s reasoning"}</Eyebrow>
          <Reasoning text={decision.reasoning} className="mt-1.5" />
        </div>

        {hasFooter && (
          <footer className="flex flex-col gap-3 border-t border-line bg-ground/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <EvidenceRow items={decision.evidence} />
            <div className="flex shrink-0 flex-wrap items-center gap-4">
              {decision.auditSeq != null && (
                <Link
                  href={orgHref(orgSlug, `/audit#seq-${decision.auditSeq}`)}
                  className="font-mono text-xs text-ink-3 transition-colors duration-150 ease-standard hover:text-ink hover:underline"
                >
                  audit #{String(decision.auditSeq).padStart(4, "0")}
                </Link>
              )}
              {decision.txHash ? (
                <Hash value={decision.txHash} href={explorerTx(decision.txHash)} />
              ) : refused ? (
                <span className="font-mono text-xs text-refused">no transaction sent</span>
              ) : null}
            </div>
          </footer>
        )}
      </article>
    </Card>
  );
}

function GuardrailBand({ guardrail, token = "USDC", action }: { guardrail: Guardrail; token?: string; action: string }) {
  return (
    <Callout tone="refused" icon={<ShieldX />} title="Blocked by code, not by the model" className="mx-4 mt-4 sm:mx-5">
      <p>The agent decided to {action}. The guardrail refused it before anything was signed or sent.</p>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
        <dt className="text-ink-3">Rule</dt>
        <dd className="font-mono text-ink [overflow-wrap:anywhere]">{guardrail.rule}</dd>
        <dt className="text-ink-3">Attempted</dt>
        <dd className="font-mono tabular-nums text-ink">
          {fmt(guardrail.attempted)} {token}
        </dd>
        <dt className="text-ink-3">Allowed</dt>
        <dd className="font-mono tabular-nums text-ink">
          {fmt(guardrail.limit)} {token}
          {guardrail.note && <span className="ml-2 font-sans text-ink-2">({guardrail.note})</span>}
        </dd>
      </dl>
    </Callout>
  );
}

function EvidenceRow({ items }: { items: Evidence[] }) {
  if (items.length === 0) return <span />;
  return (
    <ul aria-label="Evidence cited by this decision" className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={`${item.label}-${item.value}`}>
          <Badge
            shape="tag"
            tone={item.state === "missing" ? "held" : "neutral"}
            icon={item.state === "ok" ? <Check aria-hidden /> : item.state === "missing" ? <X aria-hidden /> : undefined}
            className="font-normal"
          >
            <span className={item.state === "missing" ? undefined : "text-ink-3"}>{item.label}</span>
            {item.href ? (
              <a href={item.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-agent transition-colors duration-150 ease-standard hover:underline">
                {item.value}
                <ArrowUpRight aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="font-mono text-ink">{item.value}</span>
            )}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Delete the glyphs this card no longer uses**

In `src/components/vx/Glyphs.tsx`, delete `ShieldGlyph`, `CheckGlyph` and `CrossGlyph`.
Run: `grep -rn "ShieldGlyph\|CheckGlyph\|CrossGlyph" src tests` — Expected: no output.

- [ ] **Step 5: Run the tests and the full check**

Run: `npx vitest run tests/decision-card.test.tsx` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/components/vx/DecisionCard.tsx src/components/vx/Glyphs.tsx tests/decision-card.test.tsx
git commit -m "feat(ui): the decision card from the design system

A card in the decision's tone; the guardrail refusal is a refused callout
without role=alert, since a listed refusal is standing information; evidence
is a row of tags.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 3: Treasury tiles, accounts and forecast

**Files:**
- Modify: `src/components/vx/Treasury.tsx`, `src/components/vx/Glyphs.tsx`
- Test: create `tests/treasury-display.test.tsx` (the existing `tests/balance-tile-copy.test.ts` stays as it is)

**Interfaces:**
- Consumes: `Card` (`asChild`, `interactive`, `tone`), `CardContent`, `Callout`, `Button` (`asChild`, `variant="link"`), `Eyebrow`, `SectionHeader`, `cn`; Task 1's `Money`, `Reasoning`.
- Produces (unchanged): `StatTile({ label, children, sub?, tone?, href? })`, `balanceTileCopy(mode, simulatedReserve)`, `BalanceTile({ accounts, mode })`, `AccountsList({ accounts })`, `ForecastPanel({ forecast })`, `MoreLink({ href, children })` — Task 4 and Task 6 import `MoreLink` from `@/components/vx/Treasury`.

- [ ] **Step 1: Write the failing tests** — `tests/treasury-display.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountsList, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("StatTile", () => {
  it("is a card that lifts when it links somewhere", () => {
    const markup = html(<StatTile label="Needs you" href="/o/acme/approvals">3</StatTile>);
    expect(markup).toMatch(/^<a [^>]*href="\/o\/acme\/approvals"/);
    expect(markup).toContain("hover:-translate-y-0.5");
    expect(markup).toContain("rounded-2xl");
  });

  it("is a plain card otherwise, in the held tone when something waits", () => {
    const markup = html(<StatTile label="Needs you" tone="held">3</StatTile>);
    expect(markup).toMatch(/^<div /);
    expect(markup).toContain("bg-held-soft");
    expect(markup).toContain("border-held-line");
  });
});

describe("AccountsList", () => {
  it("hatches a simulated account and says so", () => {
    const markup = html(
      <AccountsList accounts={[{ id: "a1", name: "USYC reserve", chain: "ARC-TESTNET", token: "USYC", balance: 5000, apy: 0.045, simulated: true }]} />
    );
    expect(markup).toContain("hatch");
    expect(markup).toContain("simulated");
    expect(markup).toContain("4.50% APY");
  });
});

describe("ForecastPanel", () => {
  const forecast = { horizonDays: 14, liquid: 1000, inflow: 200, outflow: 1500, recommendation: "Hold 500.00 USDC liquid until day 30." };

  it("puts the agent's recommendation in an agent callout", () => {
    const markup = html(<ForecastPanel forecast={forecast} />);
    expect(markup).toContain("Agent recommends");
    expect(markup).toContain("bg-agent-soft");
  });

  it("says a projected shortfall in the held tone, with its sign", () => {
    const markup = html(<ForecastPanel forecast={forecast} />);
    expect(markup).toContain("text-held");
    expect(markup).toContain("−");
  });
});

describe("MoreLink", () => {
  it("is a link-styled button with an arrow", () => {
    const markup = html(<MoreLink href="/o/acme/audit">Full audit log</MoreLink>);
    expect(markup).toMatch(/^<a [^>]*href="\/o\/acme\/audit"/);
    expect(markup).toContain("text-agent");
    expect(markup).toContain("<svg");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/treasury-display.test.tsx`
Expected: FAIL — tiles are `rounded-xl` with `surface-shadow`, and the recommendation is not a callout.

- [ ] **Step 3: Rewrite `src/components/vx/Treasury.tsx`**

```tsx
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money, Reasoning } from "./Primitives";
import type { Account, Forecast } from "./types";

/** One figure with its label: a card, and a lifting one when it links to the page behind the number. */
export function StatTile({
  label,
  children,
  sub,
  tone = "default",
  href,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "held";
  href?: string;
}) {
  const content = (
    <>
      <Eyebrow className={tone === "held" ? "text-held" : undefined}>{label}</Eyebrow>
      <div className="mt-2 min-w-0 text-[1.375rem] font-semibold leading-none tracking-tight text-ink sm:text-[1.625rem]">{children}</div>
      {sub && <div className="mt-2 text-[0.8125rem] leading-snug text-ink-2">{sub}</div>}
    </>
  );
  const className = cn("block min-w-0 px-4 py-4", tone === "held" && "bg-held-soft");
  return href ? (
    <Card asChild interactive tone={tone} className={className}>
      <Link href={href}>{content}</Link>
    </Card>
  ) : (
    <Card tone={tone} className={className}>
      {content}
    </Card>
  );
}

/**
 * The balance tile's label and sub-line, pinned as a pure function: a
 * sandbox workspace's funds are simulated money end to end, so it always
 * gets the fixed sandbox wording, regardless of the simulated reserve
 * amount. A live workspace keeps the on-chain label, and defers to the
 * caller's own sub-line (the simulated-reserve note, which needs the `Money`
 * component) by returning `sub: null` when there is a simulated reserve to
 * mention.
 */
export function balanceTileCopy(mode: "sandbox" | "live", simulatedReserve: number): { label: string; sub: string | null } {
  if (mode === "sandbox") {
    return { label: "Balance (simulated)", sub: "Sandbox workspace: these funds are simulated, nothing is on-chain" };
  }
  return { label: "Balance on-chain", sub: simulatedReserve > 0 ? null : "All funds shown are on-chain" };
}

export function BalanceTile({ accounts, mode }: { accounts: Account[]; mode: "sandbox" | "live" }) {
  const live = accounts.filter((account) => !account.simulated).reduce((sum, account) => sum + account.balance, 0);
  const simulated = accounts.filter((account) => account.simulated).reduce((sum, account) => sum + account.balance, 0);
  const copy = balanceTileCopy(mode, simulated);
  return (
    <StatTile
      label={copy.label}
      sub={
        copy.sub ?? (
          <span>
            + <Money value={simulated} token="USYC" simulated className="text-ink-2" /> in the simulated reserve, not counted above
          </span>
        )
      }
    >
      <Money value={live} />
    </StatTile>
  );
}

export function AccountsList({ accounts }: { accounts: Account[] }) {
  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader title="Accounts" meta={`${accounts.length} held`} />
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {accounts.map((account) => (
            <li key={account.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 sm:px-5", account.simulated && "hatch")}>
              <span className="min-w-0 truncate text-sm font-medium text-ink">{account.name}</span>
              <Money value={account.balance} token={account.token} simulated={account.simulated} className="text-right text-[0.9375rem] text-ink" />
              <span className="min-w-0 truncate font-mono text-xs text-ink-3">
                {account.chain} · {account.token}
                {account.simulated && <span className="ml-2 text-ink-2">simulated</span>}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-ink-3">{account.apy && account.apy > 0 ? `${(account.apy * 100).toFixed(2)}% APY` : "—"}</span>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

export function ForecastPanel({ forecast }: { forecast: Forecast }) {
  const projected = forecast.liquid + forecast.inflow - forecast.outflow;
  const maximum = Math.max(forecast.liquid, forecast.inflow, forecast.outflow, Math.abs(projected), 0.000001);
  const rows: Array<{ label: string; value: number; sign?: "+" | "−"; bar: string }> = [
    { label: "Liquid now", value: forecast.liquid, bar: "bg-ink-3" },
    { label: "Expected in", value: forecast.inflow, sign: "+", bar: "bg-ink-2" },
    { label: "Committed out", value: forecast.outflow, sign: "−", bar: "bg-line-strong" },
  ];
  const shortfall = projected < 0;

  return (
    <Card asChild>
      <section>
        <CardContent className="p-4 sm:p-5">
          <SectionHeader title="Cash forecast" meta={`next ${forecast.horizonDays} days`} />
          <dl className="space-y-2.5">
            {rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
                <dt className="text-[0.8125rem] text-ink-2">{row.label}</dt>
                <div className="h-1.5 rounded-full bg-raised">
                  <div className={cn("h-full rounded-full", row.bar)} style={{ width: `${(row.value / maximum) * 100}%` }} />
                </div>
                <dd className="text-right text-sm text-ink">
                  <Money value={row.value} sign={row.sign} />
                </dd>
              </div>
            ))}
            <div className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 border-t border-line pt-2.5 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
              <dt className={cn("text-[0.8125rem] font-medium", shortfall ? "text-held" : "text-ink")}>Projected</dt>
              <span />
              <dd className={cn("text-right text-base font-semibold", shortfall ? "text-held" : "text-ink")}>
                <Money value={projected} sign={shortfall ? "−" : undefined} />
              </dd>
            </div>
          </dl>
          {forecast.recommendation && (
            <Callout tone="agent" title="Agent recommends" className="mt-4">
              <Reasoning text={forecast.recommendation} className="text-[0.9375rem]" />
            </Callout>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

/** A text link to the page behind a section, with an arrow. */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="link" className="text-[0.8125rem]">
      <Link href={href}>
        {children}
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  );
}
```

- [ ] **Step 4: Delete `ArrowGlyph`**

In `src/components/vx/Glyphs.tsx`, delete `ArrowGlyph`. Run `grep -rn "ArrowGlyph" src tests` — Expected: no output.

- [ ] **Step 5: Run the tests and the full check**

Run: `npx vitest run tests/treasury-display.test.tsx tests/balance-tile-copy.test.ts` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/components/vx/Treasury.tsx src/components/vx/Glyphs.tsx tests/treasury-display.test.tsx
git commit -m "feat(ui): treasury tiles, accounts and forecast from the design system

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 4: The audit ledger, its filter and the cycle report

**Files:**
- Modify: `src/components/vx/AuditLedger.tsx`, `src/components/vx/CycleReport.tsx`, `src/components/vx/Glyphs.tsx`
- Test: create `tests/audit-ledger.test.tsx` (the existing `tests/cycle-report.test.ts` stays)

**Interfaces:**
- Consumes: `Card`, `Badge`, `chipVariants`, `CopyButton`, `Disclosure`, `Eyebrow`, `cn`; Task 1's `Hash`, `ModeBadge`, `OutcomeBadge`; Task 3's `MoreLink`.
- Produces (unchanged): `entryOutcome(entry)`, `pad(value)`, `AuditLedger({ entries, since? })`, `DomainFilter({ active?, orgSlug })`, `cycleReportHeading(cycleName, rows)`, `CycleReport({ entries, day, since, clockMode, completedAt, orgSlug })`.

- [ ] **Step 1: Write the failing tests** — `tests/audit-ledger.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { AuditLedger, DomainFilter } from "@/components/vx/AuditLedger";
import { CycleReport } from "@/components/vx/CycleReport";
import type { LedgerEntry } from "@/lib/ledger";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

const hash = (seed: string) => seed.padEnd(64, "0");

function entry(seq: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq,
    id: `entry-${seq}`,
    ts: "2026-09-29T10:00:00Z",
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: `Paid INV-${seq}`,
    detail: { day: 3 },
    bodyHash: hash(`b${seq}`),
    signature: `sig${seq}`.padEnd(86, "x"),
    prevHash: seq === 1 ? hash("0") : hash(`h${seq - 1}`),
    hash: hash(`h${seq}`),
    signingKeyId: null,
    ...overrides,
  };
}

/** The opening tag of the link whose text is exactly `text`, or of the first link containing it. */
function anchor(markup: string, text: string): string {
  return markup.match(new RegExp(`<a[^>]*>(?:(?!</a>).)*${text}</a>`))?.[0] ?? "";
}

describe("AuditLedger", () => {
  it("renders each entry as a closed disclosure anchored by its sequence number", () => {
    const markup = html(<AuditLedger entries={[entry(1), entry(2)]} />);
    expect(markup).toContain('id="seq-2"');
    expect(markup.match(/<details class="[^"]*disclosure/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<details[^>]* open=""/);
  });

  it("offers to copy the full hash, previous hash, body hash and signature", () => {
    const e = entry(2);
    const markup = html(<AuditLedger entries={[entry(1), e]} />);
    for (const what of ["hash", "previous hash", "body hash", "signature"]) {
      expect(markup).toContain(`aria-label="Copy the ${what} of #0002"`);
    }
    // The full values are on the page to copy, wrapped inside the row.
    expect(markup).toContain(e.signature);
    expect(markup).toContain("break-all");
  });

  it("says whether each entry links to the one before it", () => {
    expect(html(<AuditLedger entries={[entry(1), entry(2)]} />)).toContain("matches hash of #0001");
    expect(html(<AuditLedger entries={[entry(1), entry(2, { prevHash: hash("tampered") })]} />)).toContain("does not match hash of #0001");
    expect(html(<AuditLedger entries={[entry(1)]} />)).toContain("genesis — first link in the chain");
  });

  it("tags a sweep and a risk change in words", () => {
    const markup = html(
      <AuditLedger entries={[entry(3, { action: "compliance_sweep", domain: "compliance" }), entry(4, { action: "risk_level_changed", domain: "compliance" })]} />
    );
    expect(markup).toContain("continuous sweep");
    expect(markup).toContain("risk changed");
  });
});

describe("DomainFilter", () => {
  it("marks All as the filter in force when no domain is chosen", () => {
    const markup = html(<DomainFilter orgSlug="acme" />);
    expect(anchor(markup, "All")).toContain('aria-current="page"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks the chosen domain, and only it", () => {
    const markup = html(<DomainFilter orgSlug="acme" active="ap" />);
    expect(anchor(markup, "Payables")).toContain('aria-current="page"');
    expect(anchor(markup, "Payables")).toContain('href="/o/acme/audit?domain=ap"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("CycleReport", () => {
  it("is an agent-toned card that links the cycle's range in the audit log", () => {
    const markup = html(
      <CycleReport entries={[entry(5), entry(6)]} day={3} since={4} clockMode="simulate" completedAt={null} orgSlug="acme" />
    );
    expect(markup).toContain("border-agent-line");
    expect(markup).toContain("Day 3: the agent logged 2 entries");
    expect(markup).toContain('href="/o/acme/audit?since=4#seq-6"');
  });

  it("renders nothing when the cycle logged nothing", () => {
    expect(html(<CycleReport entries={[entry(2)]} day={3} since={4} clockMode="simulate" completedAt={null} orgSlug="acme" />)).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/audit-ledger.test.tsx`
Expected: FAIL — no copy buttons, no `disclosure` class, no `aria-current`.

- [ ] **Step 3: Rewrite `src/components/vx/AuditLedger.tsx`**

```tsx
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import type { LedgerEntry } from "@/lib/ledger";
import { DOMAIN_CODE, DOMAIN_NAME, DOMAINS, DomainGlyph } from "./Glyphs";
import { Hash, ModeBadge, OutcomeBadge } from "./Primitives";
import type { Domain, Outcome } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function entryOutcome(entry: LedgerEntry): Outcome | null {
  const execution = record(entry.detail.execution);
  const txRef = typeof execution?.txRef === "string" ? execution.txRef : undefined;
  if (entry.detail.guardrailBlocked === true) return "refused";
  if (txRef?.startsWith("0x")) return "settled";
  if (entry.action === "hold" || /\b(hold|held|awaiting|flagged)\b/i.test(entry.summary)) return "held";
  if (entry.detail.earnMode === "simulate" || txRef?.startsWith("sim_")) return "simulated";
  return null;
}

function entryDay(entry: LedgerEntry) {
  const day = typeof entry.detail.day === "number" ? entry.detail.day : undefined;
  return day != null ? `Day ${day}` : entry.ts.slice(0, 10);
}

export const pad = (value: number) => String(value).padStart(4, "0");

export function AuditLedger({ entries, since }: { entries: LedgerEntry[]; since?: number }) {
  const sorted = [...entries].sort((a, b) => b.seq - a.seq);
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const groups: Array<{ day: string; rows: LedgerEntry[] }> = [];
  for (const entry of sorted) {
    const day = entryDay(entry);
    const group = groups.at(-1);
    if (group?.day === day) group.rows.push(entry);
    else groups.push({ day, rows: [entry] });
  }

  // `overflow-clip`, not `-hidden`: a hidden overflow makes the card a scroll
  // container, and the day headers would stick to it instead of the viewport.
  // They stop below the workspace's top bar where there is one (below `lg`).
  return (
    <Card className="overflow-clip">
      <div className="hidden grid-cols-[3.25rem_3rem_5.75rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line py-2 pl-9 pr-4 sm:grid">
        <Eyebrow>Seq</Eyebrow>
        <Eyebrow>UTC</Eyebrow>
        <Eyebrow>Domain</Eyebrow>
        <Eyebrow>Entry</Eyebrow>
        <Eyebrow>Hash</Eyebrow>
      </div>
      {groups.map((group, groupIndex) => (
        <section key={`${group.day}-${groupIndex}`} aria-label={group.day}>
          <div className="sticky top-14 z-10 flex items-baseline justify-between border-b border-line bg-raised/95 px-4 py-1.5 backdrop-blur sm:pl-9 lg:top-0">
            <span className="text-[0.8125rem] font-semibold text-ink">{group.day}</span>
            <span className="font-mono text-[0.6875rem] text-ink-3">
              #{pad(group.rows.at(-1)!.seq)}–#{pad(group.rows[0].seq)} · {group.rows.length} entries
            </span>
          </div>
          <ol>
            {group.rows.map((entry, index) => (
              <AuditRow key={entry.seq} entry={entry} previous={bySeq.get(entry.seq - 1)} fresh={since != null && entry.seq > since} index={index} />
            ))}
          </ol>
        </section>
      ))}
    </Card>
  );
}

function AuditRow({ entry, previous, fresh, index }: { entry: LedgerEntry; previous?: LedgerEntry; fresh: boolean; index: number }) {
  const outcome = entryOutcome(entry);
  const refused = outcome === "refused";
  const time = entry.ts.slice(11, 16);
  const genesis = /^0+$/.test(entry.prevHash.replace(/^0x/, ""));
  const linked = genesis ? null : previous ? previous.hash === entry.prevHash : null;
  const domain = entry.domain as Domain;
  const decisionMode = typeof entry.detail.decisionMode === "string" ? entry.detail.decisionMode : undefined;
  const sweep = entry.action === "compliance_sweep";
  const changed = entry.action === "risk_level_changed";
  const seq = pad(entry.seq);

  return (
    <li
      id={`seq-${entry.seq}`}
      className={cn(
        "relative scroll-mt-24 border-b border-line last:border-b-0 lg:scroll-mt-12",
        fresh && "bg-agent-soft/60 motion-safe:animate-arrive",
        refused && "bg-refused-soft/70",
        changed && !refused && "bg-held-soft/35"
      )}
      style={fresh ? { animationDelay: `${index * 55}ms` } : undefined}
    >
      <span aria-hidden className="absolute bottom-0 left-4 top-0 w-px bg-line-strong sm:left-[1.1rem]" />
      <span
        aria-hidden
        className={cn(
          "absolute left-[0.8rem] top-[1.05rem] size-[7px] rounded-full ring-2 ring-surface sm:left-[0.93rem]",
          refused ? "bg-refused" : outcome === "settled" ? "bg-proof" : changed ? "bg-held" : "bg-line-strong"
        )}
      />
      <Disclosure
        variant="bare"
        summaryClassName="py-2.5 pl-9 pr-4 transition-colors duration-150 ease-standard hover:bg-raised/60 sm:grid sm:grid-cols-[3.25rem_3rem_5.75rem_minmax(0,1fr)_auto] sm:items-start sm:gap-x-3"
        contentClassName="space-y-3 pb-4 pl-9 pr-4 sm:pl-[calc(2.25rem+3.25rem+3rem+5.75rem+2.25rem)]"
        summary={
          <>
            <span className="font-mono text-xs tabular-nums text-ink-2">#{seq}</span>
            <span className="ml-2 font-mono text-xs tabular-nums text-ink-3 sm:ml-0">{time}</span>
            <span className="ml-2 inline-flex items-center gap-1 font-mono text-[0.6875rem] text-ink-3 sm:ml-0">
              <DomainGlyph domain={domain} className="size-2.5" />
              {DOMAIN_CODE[domain]}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:mt-0">
              <ChevronRight aria-hidden className="size-3 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
              <span className="shrink-0 text-[0.8125rem] text-ink-3">{entry.actor}</span>
              <span className={cn("min-w-0 text-sm", refused ? "text-refused" : "text-ink")}>{entry.summary}</span>
              {sweep && (
                <Badge size="sm" shape="tag" className="font-mono uppercase tracking-wider">
                  continuous sweep
                </Badge>
              )}
              {changed && (
                <Badge size="sm" shape="tag" tone="held" className="font-mono uppercase tracking-wider">
                  risk changed
                </Badge>
              )}
              <ModeBadge mode={decisionMode} />
            </span>
            <span className="mt-1 hidden justify-end sm:flex">
              <Hash value={entry.hash} />
            </span>
          </>
        }
      >
        {outcome && <OutcomeBadge outcome={outcome} />}
        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">domain</dt>
          <dd className="text-ink-2">{DOMAIN_NAME[domain]}</dd>
          <dt className="text-ink-3">action</dt>
          <dd className="font-mono text-ink-2">{entry.action}</dd>
          <dt className="text-ink-3">hash</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.hash} label={`Copy the hash of #${seq}`} />
          </dd>
          <dt className="text-ink-3">prev</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.prevHash} label={`Copy the previous hash of #${seq}`} />
            <span className="mt-0.5 block font-sans text-ink-2">
              {genesis ? (
                <span className="text-ink-3">genesis — first link in the chain</span>
              ) : linked === true ? (
                <span>matches hash of #{pad(entry.seq - 1)}</span>
              ) : linked === false ? (
                <span className="text-refused">does not match hash of #{pad(entry.seq - 1)}</span>
              ) : null}
            </span>
          </dd>
          <dt className="text-ink-3">body hash</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.bodyHash} label={`Copy the body hash of #${seq}`} />
          </dd>
          <dt className="text-ink-3">signature</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.signature} label={`Copy the signature of #${seq}`} />
          </dd>
        </dl>
        <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-ground p-3 font-mono text-xs leading-relaxed text-ink-2">{JSON.stringify(entry.detail, null, 2)}</pre>
      </Disclosure>
    </li>
  );
}

/** A long value that wraps inside its row, and a button that copies all of it. */
function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1">
      <span className="min-w-0 break-all font-mono text-ink-2">{value}</span>
      <CopyButton value={value} label={label} className="-my-1.5 shrink-0" />
    </span>
  );
}

export function DomainFilter({ active, orgSlug }: { active?: Domain; orgSlug: string }) {
  return (
    <nav aria-label="Filter audit log by domain" className="flex flex-wrap gap-1.5">
      <Link href={orgHref(orgSlug, "/audit")} aria-current={active ? undefined : "page"} className={chipVariants({ selected: !active })}>
        All
      </Link>
      {DOMAINS.map((domain) => (
        <Link
          key={domain}
          href={orgHref(orgSlug, `/audit?domain=${domain}`)}
          aria-current={active === domain ? "page" : undefined}
          className={chipVariants({ selected: active === domain })}
        >
          <DomainGlyph domain={domain} />
          {DOMAIN_NAME[domain]}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Rewrite `src/components/vx/CycleReport.tsx`**

```tsx
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import type { CycleClockMode } from "@/lib/clock";
import type { LedgerEntry } from "@/lib/ledger";
import { entryOutcome, pad } from "./AuditLedger";
import { DOMAIN_CODE, DomainGlyph, OutcomeGlyph } from "./Glyphs";
import { MoreLink } from "./Treasury";

/**
 * The header, pinned as a pure function. Its count is every row the report
 * lists, the closing `cycle_complete` row included, so the header always
 * agrees with the visible list.
 */
export function cycleReportHeading(cycleName: string, rows: ReadonlyArray<unknown>): string {
  const n = rows.length;
  return `${cycleName}: the agent logged ${n} ${n === 1 ? "entry" : "entries"}`;
}

const OUTCOME_TEXT = { settled: "text-proof", refused: "text-refused", held: "text-held" } as const;

export function CycleReport({
  entries,
  day,
  since,
  clockMode,
  completedAt,
  orgSlug,
}: {
  entries: LedgerEntry[];
  day: number;
  since: number;
  clockMode: CycleClockMode;
  completedAt: string | null;
  orgSlug: string;
}) {
  const rows = entries.filter((entry) => entry.seq > since).sort((a, b) => a.seq - b.seq);
  if (rows.length === 0) return null;
  const cycleName = clockMode === "simulate" ? `Day ${day}` : completedAt ? new Date(completedAt).toLocaleString() : "Wall-clock cycle";
  return (
    <Card asChild tone="agent" className="mb-6 p-4 sm:p-5">
      <section aria-label={`${cycleName} cycle`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <Eyebrow className="text-agent">Cycle complete</Eyebrow>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{cycleReportHeading(cycleName, rows)}</h2>
          </div>
          <MoreLink href={orgHref(orgSlug, `/audit?since=${since}#seq-${rows.at(-1)!.seq}`)}>
            #{pad(rows[0].seq)}–#{pad(rows.at(-1)!.seq)} in the audit log
          </MoreLink>
        </div>
        <ol className="mt-4 divide-y divide-line rounded-xl border border-line">
          {rows.map((entry, index) => {
            const outcome = entryOutcome(entry);
            return (
              <li key={entry.seq} className="flex items-start gap-3 px-3 py-2 motion-safe:animate-arrive" style={{ animationDelay: `${100 + index * 55}ms` }}>
                <span className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-ink-3">#{pad(entry.seq)}</span>
                <span className="mt-0.5 inline-flex w-12 shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-ink-3">
                  <DomainGlyph domain={entry.domain} className="size-2.5" />
                  {DOMAIN_CODE[entry.domain]}
                </span>
                <span className={cn("min-w-0 flex-1 text-sm", outcome === "refused" ? "text-refused" : "text-ink")}>{entry.summary}</span>
                {outcome && <OutcomeGlyph outcome={outcome} className={cn("mt-0.5 size-3.5", outcome in OUTCOME_TEXT ? OUTCOME_TEXT[outcome as keyof typeof OUTCOME_TEXT] : "text-ink-3")} />}
              </li>
            );
          })}
        </ol>
      </section>
    </Card>
  );
}
```

- [ ] **Step 5: Delete `ChevronGlyph`**

In `src/components/vx/Glyphs.tsx`, delete `ChevronGlyph`. Run `grep -rn "ChevronGlyph" src tests` — Expected: no output. `Glyphs.tsx` now exports only `DOMAINS`, `DOMAIN_CODE`, `DOMAIN_NAME`, `DomainGlyph` and `OutcomeGlyph`.

- [ ] **Step 6: Run the tests and the full check**

Run: `npx vitest run tests/audit-ledger.test.tsx tests/cycle-report.test.ts` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/components/vx/AuditLedger.tsx src/components/vx/CycleReport.tsx src/components/vx/Glyphs.tsx tests/audit-ledger.test.tsx
git commit -m "feat(ui): the audit ledger and cycle report from the design system

Rows are disclosures; the hash, previous hash, body hash and signature each
have a copy button; domain filters are chips that say which is in force.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 5: Verifying the ledger

**Files:**
- Modify: `src/components/VerifyLedgerBadge.tsx`
- Test: create `tests/verify-ledger.test.tsx`

**Interfaces:**
- Consumes: `Button` (`variant="secondary"`, `icon`, `loading`), `Callout`.
- Produces: default export `VerifyLedgerBadge({ orgSlug })` (unchanged); new `verificationVerdict(result): Verdict | null` and `interface Verdict { tone: "proof" | "refused" | "neutral"; title: string; body: string }`.

- [ ] **Step 1: Write the failing tests** — `tests/verify-ledger.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import VerifyLedgerBadge, { verificationVerdict } from "@/components/VerifyLedgerBadge";

describe("verificationVerdict", () => {
  it("has nothing to say before a check", () => {
    expect(verificationVerdict(null)).toBeNull();
  });

  it("says an intact chain in the proof tone, with its counts", () => {
    expect(verificationVerdict({ valid: true, checkedEntries: 12 })).toEqual({
      tone: "proof",
      title: "Chain intact",
      body: "12 signatures and 11 links verified.",
    });
  });

  it("names where a broken chain breaks", () => {
    expect(verificationVerdict({ valid: false, brokenAt: 42, reason: "hash mismatch" })).toEqual({
      tone: "refused",
      title: "Chain broken at #0042",
      body: "hash mismatch",
    });
  });

  it("says a check that reached no verdict is not a finding about the chain", () => {
    const verdict = verificationVerdict({ valid: null, reason: "Failed to fetch" });
    expect(verdict?.tone).toBe("neutral");
    expect(verdict?.title).toBe("Not checked");
    expect(verdict?.body).toBe("Failed to fetch. This is not a finding about the chain.");
  });
});

describe("VerifyLedgerBadge", () => {
  it("starts with the button and says nothing has been checked yet", () => {
    const markup = renderToStaticMarkup(<VerifyLedgerBadge orgSlug="acme" />);
    expect(markup).toContain("Verify hash chain");
    expect(markup).toContain("Not yet verified in this session.");
    expect(markup).toContain('type="button"');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/verify-ledger.test.tsx` — Expected: FAIL — `verificationVerdict` is not exported.

- [ ] **Step 3: Rewrite `src/components/VerifyLedgerBadge.tsx`**

```tsx
"use client";

import { ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";

interface VerificationResponse {
  /** `null` is "not checked" — see `VerificationResult` in `lib/ledger`. */
  valid?: boolean | null;
  checkedEntries?: number;
  brokenAt?: number;
  reason?: string;
  /** Configuration problems met on the way to the verdict; not about the chain. */
  warnings?: string[];
}

export interface Verdict {
  tone: "proof" | "refused" | "neutral";
  title: string;
  body: string;
}

/**
 * What a verification response says, pinned as a pure function. A request that
 * never reached a verdict is "not checked" — neutral, never "broken": calling
 * it broken would accuse the chain because the network or a key failed.
 */
export function verificationVerdict(result: VerificationResponse | null): Verdict | null {
  if (!result) return null;
  if (result.valid === true) {
    const entries = result.checkedEntries ?? 0;
    return { tone: "proof", title: "Chain intact", body: `${entries} signatures and ${Math.max(entries - 1, 0)} links verified.` };
  }
  if (result.valid === false) {
    return {
      tone: "refused",
      title: `Chain broken${result.brokenAt ? ` at #${String(result.brokenAt).padStart(4, "0")}` : ""}`,
      body: result.reason ?? "verification failed",
    };
  }
  return { tone: "neutral", title: "Not checked", body: `${result.reason ?? "no verdict was produced"}. This is not a finding about the chain.` };
}

export default function VerifyLedgerBadge({ orgSlug }: { orgSlug: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<VerificationResponse | null>(null);

  function verify() {
    startTransition(async () => {
      try {
        const response = await fetch(`/api/ledger/verify?org=${encodeURIComponent(orgSlug)}`);
        setResult((await response.json()) as VerificationResponse);
      } catch (error) {
        // A request that never arrived checked nothing. Calling that `false`
        // would accuse the chain of being broken because the network was.
        setResult({ valid: null, reason: error instanceof Error ? error.message : "Verification request failed" });
      }
    });
  }

  const verdict = verificationVerdict(result);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Button variant="secondary" icon={<ShieldCheck />} loading={pending} onClick={verify} className="shrink-0">
        {pending ? "Checking every signature…" : result ? "Verify again" : "Verify hash chain"}
      </Button>
      <div aria-live="polite" className="min-w-0 flex-1">
        {verdict ? (
          <Callout tone={verdict.tone} title={verdict.title}>
            {verdict.body}
            {result?.warnings?.map((warning) => (
              <span key={warning} className="mt-1 block text-refused">
                Configuration: {warning}
              </span>
            ))}
          </Callout>
        ) : (
          !pending && <p className="py-2 text-[0.8125rem] text-ink-3">Not yet verified in this session.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the full check**

Run: `npx vitest run tests/verify-ledger.test.tsx` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/VerifyLedgerBadge.tsx tests/verify-ledger.test.tsx
git commit -m "feat(ui): the ledger check's verdict as a callout

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 6: Page chrome — treasury, audit and compliance

**Files:**
- Modify: `src/app/o/[slug]/console/page.tsx`, `src/app/o/[slug]/audit/page.tsx`, `src/app/o/[slug]/compliance/page.tsx`

**Interfaces:**
- Consumes: `SectionHeader`, `EmptyState`, `Card`, `Callout`, `Disclosure`, `Button`, `Eyebrow`, `CopyButton`; Task 3's `MoreLink`; Task 4's `pad`.
- Produces: nothing new. Each page keeps its `requireMembership`/`inOrg`/`dynamic`/`PageHead` contract.

- [ ] **Step 1: The treasury page** (`console/page.tsx`)

Replace the import `import { Money, SectionHead } from "@/components/vx/Primitives";` with:

```tsx
import { Money } from "@/components/vx/Primitives";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
```

Replace every `<SectionHead ` with `<SectionHeader ` (three places; the props are the same). Replace the empty treasury-decisions paragraph:

```tsx
<p className="rounded-lg border border-dashed border-line-strong p-5 text-sm text-ink-2">Run an agent cycle to see why cash was swept, redeemed, or held liquid.</p>
```

with

```tsx
<EmptyState compact title="No treasury decisions yet" body="Run an agent cycle to see why cash was swept, redeemed, or held liquid." />
```

- [ ] **Step 2: The audit page** (`audit/page.tsx`)

Replace the imports

```tsx
import { Hash, Label } from "@/components/vx/Primitives";
import { EmptyState, PageHead, ProductShell } from "@/components/vx/Shell";
```

with

```tsx
import { ArrowRight, ScrollText, SearchX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Hash } from "@/components/vx/Primitives";
import { PageHead, ProductShell } from "@/components/vx/Shell";
```

Replace the hash-chain section (from `<section aria-label="Hash chain"` to its closing `</section>`) with:

```tsx
        <Card asChild className="mb-6 p-4 sm:p-6">
          <section aria-label="Hash chain">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <div>
                <dt><Eyebrow>Entries</Eyebrow></dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{totalEntries}</dd>
              </div>
              <div>
                <dt><Eyebrow>Head</Eyebrow></dt>
                <dd className="mt-1.5 font-mono text-[0.8125rem] text-ink">{head ? `#${pad(head.seq)}` : "—"}</dd>
              </div>
              <div className="col-span-2 min-w-0">
                <dt><Eyebrow>Head hash</Eyebrow></dt>
                <dd className="mt-1 flex items-center gap-1">
                  {head ? (
                    <>
                      <Hash value={head.hash} className="text-ink-2" />
                      <CopyButton value={head.hash} label="Copy the head hash" />
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="mt-4 border-t border-line pt-4">
              <VerifyLedgerBadge orgSlug={slug} />
            </div>
          </section>
        </Card>
```

Replace the key-warnings section (from `{keyWarnings.length > 0 && (` to its closing `)}`) with:

```tsx
        {keyWarnings.length > 0 && (
          <Callout tone="refused" title="Ledger key configuration needs attention" className="mb-6">
            <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-xs text-refused">
              {keyWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-3 text-ink-2">
              The entries below are shown from the database regardless. A key that cannot be read is a
              configuration problem, not a finding about the chain.
            </p>
          </Callout>
        )}
```

Replace the public-key `<details>` (from `<details className="surface-shadow mb-6` to its `</details>`) with:

```tsx
        <Disclosure
          className="mb-6"
          summary={
            <span>
              Ledger signing public key
              {keyId ? (
                <>
                  {" "}
                  · <span className="font-mono text-ink-2">{keyId}</span>
                </>
              ) : null}
            </span>
          }
          contentClassName="text-xs text-ink-3"
        >
          {publicKey ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-ground p-3 font-mono text-ink-2">{publicKey}</pre>
          ) : (
            <p className="rounded-xl bg-ground p-3">
              This organization has no readable ledger key, so signatures on the entries below cannot
              be checked here. The key that signed them has to be stored on the organization — for the
              founding organization, <span className="font-mono text-ink-2">npm run org:adopt-env</span>.
              Nothing about the chain is known to be wrong — it is unverified, which is a different
              statement.
            </p>
          )}
        </Disclosure>
```

Replace the two empty states:

```tsx
          <EmptyState title="The chain is empty" body={<>The first cycle writes entry <span className="font-mono text-ink">#0001</span>, links it to a genesis hash of zeros, and signs it with this deployment’s Ed25519 key.</>} />
        ) : shown.length === 0 ? (
          <EmptyState title="No entries in this view" body="Choose another domain or return to the newest entries." />
```

with

```tsx
          <EmptyState titleAs="h2" icon={<ScrollText />} title="The chain is empty" body={<>The first cycle writes entry <span className="font-mono text-ink">#0001</span>, links it to a genesis hash of zeros, and signs it with this deployment’s Ed25519 key.</>} />
        ) : shown.length === 0 ? (
          <EmptyState titleAs="h2" icon={<SearchX />} title="No entries in this view" body="Choose another domain or return to the newest entries." />
```

Replace the "Older entries" link:

```tsx
                <Link href={orgHref(slug, `/audit?before=${entries.at(-1)!.seq}${domain ? `&domain=${domain}` : ""}`)} className="rounded-md border border-line-strong px-4 py-2 text-sm text-agent hover:bg-raised">Older entries →</Link>
```

with

```tsx
                <Button asChild variant="secondary" size="sm">
                  <Link href={orgHref(slug, `/audit?before=${entries.at(-1)!.seq}${domain ? `&domain=${domain}` : ""}`)}>
                    Older entries
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
```

- [ ] **Step 3: The compliance page** (`compliance/page.tsx`)

Replace the import `import { Card, Label, Money, SectionHead } from "@/components/vx/Primitives";` with:

```tsx
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { pad } from "@/components/vx/AuditLedger";
import { Money } from "@/components/vx/Primitives";
import { MoreLink } from "@/components/vx/Treasury";
```

Replace the sweep section (from `{lastSweep && (` to its closing `)}`) with:

```tsx
        {lastSweep && (
          <Callout tone={lastSweepComplete ? "proof" : "refused"} title="Latest continuous screening sweep" className="mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-ink">{lastSweep.summary}</p>
                {!lastSweepComplete && <p className="mt-1 text-xs text-refused">Incomplete — no failed lookup was treated as clear, and every previous verdict remains in force.</p>}
              </div>
              <MoreLink href={orgHref(slug, `/audit#seq-${lastSweep.seq}`)}>audit #{pad(lastSweep.seq)}</MoreLink>
            </div>
          </Callout>
        )}
```

In the counterparty cards: `<Card key={counterparty.id} className="p-4 sm:p-5" tone={…}>` keeps its props (it now resolves to `ui/Card`, whose tones include `default`, `held` and `refused`); replace both `<Label>` elements with `<Eyebrow>` (and `</Label>` with `</Eyebrow>`). Replace `<SectionHead title="Counterparties" …/>` with `<SectionHeader title="Counterparties" …/>`.

Replace the risk-changes section (from `<section className="mt-8">` to its `</section>`) with:

```tsx
        <section className="mt-8">
          <SectionHeader title="Risk-level changes" meta="events where screening changed authority" action={<MoreLink href={orgHref(slug, "/audit?domain=compliance")}>Compliance audit</MoreLink>} />
          {riskChanges.length === 0 ? (
            <EmptyState compact title="No risk tier changed after initial screening" body="The sweep above still proves screening ran." />
          ) : (
            <Card asChild tone="held" className="overflow-hidden">
              <ol className="divide-y divide-line">
                {riskChanges.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-sm text-held">{entry.summary}</span>
                    <Link href={orgHref(slug, `/audit#seq-${entry.seq}`)} className="font-mono text-xs text-agent transition-colors duration-150 ease-standard hover:underline">
                      #{pad(entry.seq)}
                    </Link>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </section>
```

- [ ] **Step 4: Check and commit**

Run: `grep -n "surface-shadow\|SectionHead \|<Label\|rounded-md border\|rounded-lg border" "src/app/o/[slug]/console/page.tsx" "src/app/o/[slug]/audit/page.tsx" "src/app/o/[slug]/compliance/page.tsx"` — Expected: no output.
Run: `npm run verify` — Expected: green (access-gates and navigation tests included).

```bash
git add "src/app/o/[slug]/console/page.tsx" "src/app/o/[slug]/audit/page.tsx" "src/app/o/[slug]/compliance/page.tsx"
git commit -m "feat(ui): treasury, audit and compliance page chrome from the design system

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 7: Page chrome — counterparties, contractors and invoices

**Files:**
- Modify: `src/app/o/[slug]/counterparties/page.tsx`, `src/app/o/[slug]/contractors/page.tsx`, `src/app/o/[slug]/invoices/page.tsx`

**Interfaces:**
- Consumes: `SectionHeader`, `EmptyState`, `Card`, `Callout`, `Badge`, `Button`.
- Produces: nothing new.

- [ ] **Step 1: The counterparties page**

Replace `import { Money, SectionHead } from "@/components/vx/Primitives";` with:

```tsx
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money } from "@/components/vx/Primitives";
```

Replace the `RISK_STYLE` constant with:

```tsx
const RISK_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  clear: "proof",
  medium: "held",
  high: "refused",
  unscreened: "neutral",
};
```

Replace both `<SectionHead ` with `<SectionHeader `. Replace the non-writer paragraph

```tsx
<p className="rounded-lg border border-dashed border-line-strong px-5 py-6 text-sm text-ink-2">Only an owner or admin of this workspace can add counterparties.</p>
```

with `<Callout>Only an owner or admin of this workspace can add counterparties.</Callout>`.

Replace the opening `<article key={counterparty.id} className="surface-shadow min-w-0 rounded-xl border border-line bg-surface p-4">` with

```tsx
<Card asChild key={counterparty.id} className="min-w-0 p-4">
  <article>
```

and its closing `</article>` with `</article>\n</Card>`. Replace the risk pill

```tsx
<span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${RISK_STYLE[counterparty.risk_level] ?? RISK_STYLE.unscreened}`}>{counterparty.risk_level}</span>
```

with

```tsx
<Badge size="sm" dot tone={RISK_TONE[counterparty.risk_level] ?? "neutral"} className="shrink-0 capitalize">
  {counterparty.risk_level}
</Badge>
```

- [ ] **Step 2: The contractors page — an empty state for a workspace with no milestones**

Add imports:

```tsx
import { Flag } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
```

Replace `<div className="space-y-5">` … `</div>` (the decisions list) with:

```tsx
        {decisions.length === 0 ? (
          <EmptyState
            titleAs="h2"
            icon={<Flag />}
            title="No milestones yet"
            body="Contractor milestones appear here once they are recorded. Pay is released when the work is verified."
          />
        ) : (
          <div className="space-y-5">
            {decisions.map((decision, index) => (
              <div key={decision.id}>
                <DecisionCard decision={decision} orgSlug={slug} />
                {canWrite && (
                  <MilestoneVerification
                    orgSlug={slug}
                    milestoneId={milestones[index].id}
                    verified={milestones[index].verified}
                    disabled={milestones[index].status === "paid"}
                  />
                )}
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 3: The invoices page**

Replace

```tsx
import { SectionHead } from "@/components/vx/Primitives";
import { EmptyState, PageHead, ProductShell } from "@/components/vx/Shell";
```

with

```tsx
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
```

Replace every `<SectionHead ` with `<SectionHeader `. Replace the status-filter banner (from `{filter && (` to its closing `)}`) with:

```tsx
        {filter && (
          <Callout tone="held" className="mb-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                Showing status: <span className="font-mono">{filter}</span>
              </span>
              <Button asChild variant="link" className="ml-auto">
                <Link href={orgHref(slug, "/invoices")}>Clear filter</Link>
              </Button>
            </div>
          </Callout>
        )}
```

In `InvoiceSection`, replace `<EmptyState title={…} body="There are no records in this view." />` with `<EmptyState titleAs="h2" compact title={`No ${title.toLowerCase()} here`} body="There are no records in this view." />` and `<SectionHead ` with `<SectionHeader `.

- [ ] **Step 4: Check and commit**

Run: `grep -n "surface-shadow\|SectionHead \|RISK_STYLE\|rounded-md border\|rounded-lg border" "src/app/o/[slug]/counterparties/page.tsx" "src/app/o/[slug]/contractors/page.tsx" "src/app/o/[slug]/invoices/page.tsx"` — Expected: no output.
Run: `npm run verify` — Expected: green.

```bash
git add "src/app/o/[slug]/counterparties/page.tsx" "src/app/o/[slug]/contractors/page.tsx" "src/app/o/[slug]/invoices/page.tsx"
git commit -m "feat(ui): counterparties, contractors and invoices page chrome from the design system

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 8: The insights charts' chrome

**Files:**
- Modify: `src/components/vx/InsightsCharts.tsx` (chrome only: `Provenance`, `ChartCard`, `EmptyChart`, `DetailsTable`, `MetricPlot`'s frame, legend swatches, bar tracks; the SVG drawing is unchanged)
- Test: create `tests/insights-charts.test.tsx`

**Interfaces:**
- Consumes: `Badge`, `Card`, `EmptyState`, `Disclosure`, `Eyebrow`, `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `cn`; Task 1's `fmt`.
- Produces: `InsightsCharts({ data })` — unchanged.

- [ ] **Step 1: Write the failing tests** — `tests/insights-charts.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import type { InsightsData } from "@/lib/insights";

const empty: InsightsData = { transfers: [], runs: [], snapshots: [], treasuryMoves: [], screenings: [] };

describe("InsightsCharts", () => {
  it("shows an empty state in every chart card before anything is measured", () => {
    const markup = renderToStaticMarkup(<InsightsCharts data={empty} />);
    expect(markup.match(/recorded yet/g)).toHaveLength(5);
    expect(markup.match(/Run an agent cycle to populate this\./g)).toHaveLength(5);
    expect(markup).not.toContain("<svg");
  });

  it("says where transfers came from in words, and keeps the receipts in a table", () => {
    const data: InsightsData = {
      ...empty,
      transfers: [
        { id: "t1", targetType: "invoice", targetId: "i1", txRef: "0xabc0000000000000", feeUsd: 0.0031, feeSource: "chain_reported", settledInMs: 812, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-29T10:00:00Z", status: "complete" },
        { id: "t2", targetType: "invoice", targetId: "i2", txRef: "sim_000000000000", feeUsd: 0.0029, feeSource: "simulated_profile", settledInMs: null, chain: "ARC-TESTNET", providerMode: "simulate", executedAt: "2026-09-29T11:00:00Z", status: "complete" },
      ],
    };
    const markup = renderToStaticMarkup(<InsightsCharts data={data} />);
    expect(markup).toContain("Transfers · MIXED");
    expect(markup).toContain("Transfer receipt table");
    expect(markup).toMatch(/<details class="[^"]*disclosure/);
    expect(markup).toContain("<table");
    expect(markup).not.toContain("rounded-sm");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/insights-charts.test.tsx` — Expected: FAIL (the empty charts have no “Run an agent cycle to populate this.” sentence of their own; the tables are plain `<details>`; legends use `rounded-sm`).

- [ ] **Step 3: Replace the chrome helpers**

In `src/components/vx/InsightsCharts.tsx`, replace the import `import { Card, fmt, Label } from "./Primitives";` with:

```tsx
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { fmt } from "./Primitives";
```

Replace the functions `Provenance`, `ChartCard`, `EmptyChart` and `DetailsTable` with:

```tsx
function Provenance({ modes, detail }: { modes: Array<"live" | "simulate">; detail: string }) {
  const label = modeLabel(modes);
  return (
    <Badge size="sm" shape="tag" dot tone={label === "LIVE" ? "proof" : "simulated"} className="shrink-0 font-mono tracking-[0.08em]">
      {detail} · {label}
    </Badge>
  );
}

function ChartCard({ title, description, provenance, children }: {
  title: string;
  description: string;
  provenance?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card asChild className="min-w-0 overflow-hidden p-5 sm:p-6">
      <section>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>
          </div>
          {provenance}
        </div>
        <div className="mt-6">{children}</div>
      </section>
    </Card>
  );
}

/** A chart with nothing measured yet: what is missing, and how to get it. */
function EmptyChart({ what }: { what: string }) {
  return <EmptyState compact title={`No ${what} recorded yet`} body="Run an agent cycle to populate this." />;
}

function DetailsTable({ summary, headers, rows }: {
  summary: string;
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <Disclosure
      variant="bare"
      className="mt-4 border-t border-line pt-3"
      summaryClassName="w-fit"
      contentClassName="mt-3"
      summary={
        <span className="inline-flex items-center gap-1 text-xs font-medium text-agent transition-colors duration-150 ease-standard hover:underline">
          <ChevronRight aria-hidden className="size-3.5 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          {summary}
        </span>
      }
    >
      <Table className="min-w-[34rem] text-xs">
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header} className="px-2 py-2">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <TableCell key={cellIndex} className="whitespace-nowrap px-2 py-2 tabular-nums text-ink-2">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Disclosure>
  );
}
```

- [ ] **Step 4: Replace the empty-state call sites, the plot frame, the legends and the bar tracks**

Make exactly these replacements in the same file:

| Find | Replace with |
|---|---|
| `<EmptyChart>No measured transfers recorded yet — run an agent cycle to populate this.</EmptyChart>` | `<EmptyChart what="measured transfers" />` |
| `<EmptyChart>No cycles recorded yet — run an agent cycle to populate this.</EmptyChart>` (three places) | `<EmptyChart what="cycles" />` |
| `<EmptyChart>No screening checks recorded yet — run an agent cycle to populate this.</EmptyChart>` | `<EmptyChart what="screening checks" />` |
| `rounded-md border border-dashed border-line text-center text-xs text-ink-3">No confirmed measurement` | `rounded-xl border border-dashed border-line text-center text-xs text-ink-3">No confirmed measurement` |
| `<Label>{label}</Label>` | `<Eyebrow>{label}</Eyebrow>` |
| `inline-block size-2 rounded-sm` (every legend swatch) | `inline-block size-2 rounded-full` |
| `<span className="mr-1.5 inline-block size-2 bg-agent" />Model` | `<span className="mr-1.5 inline-block size-2 rounded-full bg-agent" />Model` |
| `<span className="mr-1.5 inline-block size-2 bg-line-strong" />Heuristic` | `<span className="mr-1.5 inline-block size-2 rounded-full bg-line-strong" />Heuristic` |
| `flex h-5 min-w-0 overflow-hidden rounded-sm bg-raised` (both bar tracks) | `flex h-5 min-w-0 overflow-hidden rounded-md bg-raised` |

Run: `grep -n "rounded-sm\|rounded border\|<Label\|EmptyChart>" src/components/vx/InsightsCharts.tsx` — Expected: no output.

- [ ] **Step 5: Run the tests and the full check**

Run: `npx vitest run tests/insights-charts.test.tsx tests/insights.test.ts` — Expected: PASS.
Run: `npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/components/vx/InsightsCharts.tsx tests/insights-charts.test.tsx
git commit -m "feat(ui): insights chart chrome from the design system

Cards, provenance badges, empty states and receipt tables in disclosures;
the charts themselves are drawn as before.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 9: The domain components on `/design`

**Files:**
- Modify: `src/app/design/fixtures.ts`, `src/app/design/page.tsx`

**Interfaces:**
- Consumes: every domain component from Tasks 1–8 (`DecisionCard`, `StatTile`, `BalanceTile`, `AccountsList`, `ForecastPanel`, `AuditLedger`, `DomainFilter`, `CycleReport`, `ProvenanceBar`, `RiskDial`, `PerformanceHistory`, `VerifyLedgerBadge`, `InsightsCharts`), and the types `Decision`, `Account`, `Forecast`, `LedgerEntry`, `ProvenanceLeg`, `InsightsData`, `CounterpartyHistoryInputs`.
- Produces: `/design#domain`.

- [ ] **Step 1: Add fixtures** — append to `src/app/design/fixtures.ts` (keep the existing exports and add these imports at the top of the file):

```ts
import type { Account, Decision, Forecast } from "@/components/vx/types";
import type { ProvenanceLeg } from "@/components/vx/Provenance";
import type { CounterpartyHistoryInputs } from "@/lib/agent/counterparty-history";
import type { InsightsData } from "@/lib/insights";
import type { LedgerEntry } from "@/lib/ledger";
```

```ts
const reasoning = "Paid INV-204 for 1,250.00 USDC because PO-100 matched, the goods were received on day 26, and Northwind Supply screened clear.";

export const DECISIONS: Decision[] = [
  { id: "design-d1", domain: "ap", action: "Paid", subject: "INV-204 to Northwind Supply", outcome: "settled", amount: 1250, reasoning, decisionMode: "llm", evidence: [{ label: "PO", value: "PO-100", state: "ok" }, { label: "Receipt", value: "day 26", state: "ok" }], txHash: `0x${"7a".repeat(32)}`, auditSeq: 41, at: "2026-09-29T10:15:00Z" },
  { id: "design-d2", domain: "ap", action: "Held", subject: "INV-311 from Contoso Retail", outcome: "held", amount: 4800, reasoning: "Held INV-311: no receipt is recorded for PO-311, so the three-way match is incomplete.", decisionMode: "heuristic", evidence: [{ label: "PO", value: "PO-311", state: "ok" }, { label: "Receipt", value: "missing", state: "missing" }], auditSeq: 42, at: "2026-09-29T10:16:00Z" },
  { id: "design-d3", domain: "ap", action: "Pay", subject: "INV-512 to Grace Hopper Studio", outcome: "refused", amount: 9000, reasoning: "The model argued to pay INV-512 in full on day 27.", decisionMode: "llm", guardrail: { rule: "counterparty.payment_limit", attempted: 9000, limit: 5000, note: "new vendor" }, evidence: [], auditSeq: 43, at: "2026-09-29T10:17:00Z" },
  { id: "design-d4", domain: "treasury", action: "Swept", subject: "2,000.00 USDC into the USYC reserve", outcome: "simulated", amount: 2000, reasoning: "Swept 2,000.00 USDC into USYC because 14-day obligations are covered twice over.", evidence: [], at: "2026-09-29T10:18:00Z" },
  { id: "design-d5", domain: "ar", action: "Scheduled", subject: "a reminder for INV-88 to Contoso Retail", outcome: "scheduled", amount: 3200, reasoning: "Scheduled a reminder: INV-88 is due on day 30 and Contoso Retail paid late once before.", evidence: [], auditSeq: 44, at: "2026-09-29T10:19:00Z" },
  { id: "design-d6", domain: "contractor", action: "Recorded", subject: "milestone 2 for Grace Hopper Studio", outcome: "recorded", reasoning: "Recorded milestone 2 as delivered; pay waits for a person to verify the work.", evidence: [{ label: "PR", value: "gh-pr#12", href: "https://github.com/", state: "neutral" }], at: "2026-09-29T10:20:00Z" },
];

export const ACCOUNTS: Account[] = [
  { id: "design-a1", name: "Operating wallet", chain: "ARC-TESTNET", token: "USDC", balance: 18250.5, apy: null, simulated: false },
  { id: "design-a2", name: "USYC reserve", chain: "ARC-TESTNET", token: "USYC", balance: 5000, apy: 0.045, simulated: true },
];

export const FORECAST: Forecast = { horizonDays: 14, liquid: 18250.5, inflow: 3200, outflow: 24100, recommendation: "Redeem 2,700.00 USDC from the reserve before day 30 to cover INV-512 and INV-311." };

export const PROVENANCE: ProvenanceLeg[] = [
  { label: "Payments", detail: "Arc testnet", live: true },
  { label: "Yield", detail: "USYC reserve", live: false },
  { label: "Screening", detail: "bundled list", live: false },
];

export const HISTORY: CounterpartyHistoryInputs = {
  paidWithoutIntervention: 7,
  informationRequested: 1,
  heldOrFlagged: 2,
  duplicateSubmissions: 0,
  riskTierChanges: 1,
  heldByOurPolicy: 1,
};

const hex = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);

/** Six linked entries, newest last, the way the ledger writes them. */
export const LEDGER: LedgerEntry[] = [
  ["ap", "ap_pay", "Paid INV-204 to Northwind Supply", { day: 26, decisionMode: "llm", execution: { txRef: `0x${"7a".repeat(32)}` } }],
  ["ap", "hold", "Held INV-311: receipt missing", { day: 26 }],
  ["ap", "ap_pay", "Refused INV-512: above the counterparty limit", { day: 27, guardrailBlocked: true }],
  ["compliance", "compliance_sweep", "Screened 3 counterparties", { day: 27 }],
  ["compliance", "risk_level_changed", "Contoso Retail moved from clear to medium", { day: 27 }],
  ["treasury", "sweep_to_usyc", "Swept 2,000.00 USDC into USYC", { day: 27, earnMode: "simulate" }],
].map(([domain, action, summary, detail], index) => ({
  seq: index + 1,
  id: `design-e${index + 1}`,
  ts: `2026-09-2${index < 2 ? 8 : 9}T1${index}:0${index}:00Z`,
  actor: "agent" as const,
  domain: domain as LedgerEntry["domain"],
  action: action as string,
  summary: summary as string,
  detail: detail as Record<string, unknown>,
  bodyHash: hex(index + 40),
  signature: `${hex(index + 80)}${hex(index + 81)}`.slice(0, 86),
  prevHash: index === 0 ? "0".repeat(64) : hex(index),
  hash: hex(index + 1),
  signingKeyId: null,
}));

export const INSIGHTS: InsightsData = {
  transfers: [
    { id: "design-t1", targetType: "invoice", targetId: "design-i1", txRef: `0x${"7a".repeat(32)}`, feeUsd: 0.0031, feeSource: "chain_reported", settledInMs: 812, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-28T10:00:00Z", status: "complete" },
    { id: "design-t2", targetType: "milestone", targetId: "design-m1", txRef: `0x${"3c".repeat(32)}`, feeUsd: 0.0027, feeSource: "chain_reported", settledInMs: 640, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-29T10:00:00Z", status: "complete" },
  ],
  runs: [
    { id: "design-r1", startedAt: "2026-09-28T09:59:00Z", finishedAt: "2026-09-28T10:01:00Z", durationMs: 118000, decisionCount: 5, paidCount: 2, heldCount: 1, flaggedCount: 0, awaitingInfoCount: 1, releasedCount: 1, modelDecisionCount: 3, heuristicDecisionCount: 2, guardrailOverrideCount: 0, referenceDisagreementCount: 0, status: "completed", failedStage: null, errorMessage: null, chainMode: "live", screeningMode: "simulate" },
    { id: "design-r2", startedAt: "2026-09-29T09:59:00Z", finishedAt: "2026-09-29T10:02:00Z", durationMs: 171000, decisionCount: 6, paidCount: 1, heldCount: 2, flaggedCount: 1, awaitingInfoCount: 0, releasedCount: 1, modelDecisionCount: 4, heuristicDecisionCount: 2, guardrailOverrideCount: 1, referenceDisagreementCount: 1, status: "completed", failedStage: null, errorMessage: null, chainMode: "live", screeningMode: "simulate" },
  ],
  snapshots: [
    { id: "design-s1", cycleRunId: "design-r1", capturedAt: "2026-09-28T10:01:00Z", totalLiquid: 21000, openPayables: 14000, openReceivables: 3200, obligationsDue7d: 6000, obligationsDue14d: 14000, reservePosition: 3000, chainMode: "live" },
    { id: "design-s2", cycleRunId: "design-r2", capturedAt: "2026-09-29T10:02:00Z", totalLiquid: 18250.5, openPayables: 13800, openReceivables: 3200, obligationsDue7d: 9000, obligationsDue14d: 24100, reservePosition: 5000, chainMode: "live" },
  ],
  treasuryMoves: [{ id: "design-mv1", action: "sweep_to_usyc", amount: 2000, createdAt: "2026-09-29T10:01:30Z" }],
  screenings: [
    { id: "design-sc1", counterpartyId: COUNTERPARTIES[0].id, counterpartyName: "Northwind Supply", riskLevel: "clear", previousRiskLevel: "clear", tierChanged: false, mode: "simulate", source: "bundled list", status: "complete", createdAt: "2026-09-29T10:00:05Z" },
    { id: "design-sc2", counterpartyId: COUNTERPARTIES[2].id, counterpartyName: "Contoso Retail", riskLevel: "medium", previousRiskLevel: "clear", tierChanged: true, mode: "simulate", source: "bundled list", status: "complete", createdAt: "2026-09-29T10:00:06Z" },
    { id: "design-sc3", counterpartyId: COUNTERPARTIES[1].id, counterpartyName: "Grace Hopper Studio", riskLevel: "clear", previousRiskLevel: null, tierChanged: false, mode: "simulate", source: "bundled list", status: "failed", createdAt: "2026-09-29T10:00:07Z" },
  ],
};
```

If TypeScript rejects a fixture field (a type has changed since this plan), change the fixture to match the type — never the type.

- [ ] **Step 2: Add the section to `/design`**

In `src/app/design/page.tsx`, add imports:

```tsx
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { AuditLedger, DomainFilter } from "@/components/vx/AuditLedger";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { ProvenanceBar } from "@/components/vx/Provenance";
import { RiskDial } from "@/components/vx/RiskDial";
import { AccountsList, BalanceTile, ForecastPanel, StatTile } from "@/components/vx/Treasury";
import { ACCOUNTS, DECISIONS, FORECAST, HISTORY, INSIGHTS, LEDGER, PROVENANCE } from "./fixtures";
```

(merge the last one into the existing `./fixtures` import). Add `["domain", "Domain components"]` to `SECTIONS` just before `["screens", "Screens"]`, and before the `screens` `<Section>` add:

```tsx
          <Section id="domain" title="Domain components" description="decisions, treasury, ledger and charts, from fixtures">
            <ProvenanceBar legs={PROVENANCE} />
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
              <BalanceTile accounts={ACCOUNTS} mode="live" />
              <StatTile label="Paid out to date" sub="2 settled on-chain">
                1,250.00
              </StatTile>
              <StatTile label="Decisions logged" href="/design#domain" sub="Every entry is hash-linked and signed">
                6
              </StatTile>
              <StatTile label="Needs you" tone="held" href="/design#domain" sub="Waiting for a person's decision">
                2
              </StatTile>
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <AccountsList accounts={ACCOUNTS} />
              <ForecastPanel forecast={FORECAST} />
            </div>
            <div className="space-y-4">
              {DECISIONS.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} orgSlug={DESIGN_SLUG} />
              ))}
            </div>
            <CycleReport entries={LEDGER} day={27} since={3} clockMode="simulate" completedAt={null} orgSlug={DESIGN_SLUG} />
            <DomainFilter orgSlug={DESIGN_SLUG} active="ap" />
            <AuditLedger entries={LEDGER} since={5} />
            <Card className="p-4 sm:p-6">
              <VerifyLedgerBadge orgSlug={DESIGN_SLUG} />
            </Card>
            <Card className="space-y-4 p-4 sm:p-6">
              <RiskDial risk="unscreened" baseline={null} effective={null} />
              <RiskDial risk="clear" baseline={5000} effective={5000} />
              <RiskDial risk="medium" baseline={5000} effective={2500} />
              <RiskDial risk="high" baseline={5000} effective={0} />
              <PerformanceHistory score={0.82} inputs={HISTORY} />
            </Card>
            <InsightsCharts data={INSIGHTS} />
            <InsightsCharts data={{ transfers: [], runs: [], snapshots: [], treasuryMoves: [], screenings: [] }} />
          </Section>
```

- [ ] **Step 3: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/app/design/fixtures.ts src/app/design/page.tsx
git commit -m "feat(ui): the domain components on /design, from fixtures

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 10: Remove the old pieces and add the consistency tests

**Files:**
- Modify: `src/components/vx/Primitives.tsx`, `src/components/vx/Shell.tsx`, `src/app/globals.css`, `README.md`
- Create: `tests/ui-consistency.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `tests/ui-consistency.test.ts`.

- [ ] **Step 1: Delete the deprecated wrappers**

Delete `Label`, `Card` and `SectionHead` from `src/components/vx/Primitives.tsx` (and its `ReactNode` import if nothing else uses it). Delete the `EmptyState` wrapper and the `EmptyState as EmptyStateBase` import from `src/components/vx/Shell.tsx`.

Run: `grep -rn "SectionHead\b\|from \"@/components/vx/Primitives\"" src | grep -E "\bLabel\b|\bCard\b|SectionHead\b"; grep -rn "EmptyState" src --include=*.tsx | grep "vx/Shell"`
Expected: no output. If a caller remains, move it to the `ui/` primitive the same way Tasks 6–7 did.

- [ ] **Step 2: Delete the old CSS utilities**

In `src/app/globals.css`, delete the three blocks `@utility surface-shadow { … }`, `@utility brand-shadow { … }` and `@utility logo-shadow { … }`.

Run: `grep -rn "surface-shadow\|brand-shadow\|logo-shadow" src` — Expected: no output (`drop-shadow-logo` is the token that replaced `logo-shadow` and stays).

- [ ] **Step 3: Write the consistency tests** — `tests/ui-consistency.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps every screen on the design system (spec §8): a new file that renders a
 * raw control, hard-codes a colour, invents a radius or brings back a removed
 * utility fails here, with the file and line of each offence.
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const UI = path.join(SRC, "components", "ui") + path.sep;

function walk(dir: string, keep: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, keep) : keep.test(name) ? [full] : [];
  });
}

const TSX = walk(SRC, /\.tsx$/);
const OUTSIDE_UI = TSX.filter((file) => !file.startsWith(UI));
const STYLES = walk(SRC, /\.(tsx|ts|css)$/);

function offences(files: string[], pattern: RegExp, keep: (match: string) => boolean = () => true): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(pattern)]
      .filter((match) => keep(match[0]))
      .map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${path.relative(ROOT, file).replaceAll(path.sep, "/")}:${line}: ${match[0].replace(/\s+/g, " ").slice(0, 80)}`;
      });
  });
}

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOUR_UTILITY = "bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow";

describe("the design system holds", () => {
  it("renders no raw button, select or textarea outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /<(?:button|select|textarea)\b/g)).toEqual([]);
  });

  it("renders no visible raw input outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /<input\b[^>]*>/g, (tag) => !/type="hidden"/.test(tag))).toEqual([]);
  });

  it("hard-codes no colour in a .tsx file", () => {
    expect(offences(TSX, /["'`]#[0-9a-fA-F]{3,8}["'`]|-\[#[0-9a-fA-F]{3,8}\]|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/g)).toEqual([]);
  });

  it("uses no default-palette or white/black colour utility", () => {
    const utility = new RegExp(`(?<![\\w-])(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`, "g");
    expect(offences(TSX, utility)).toEqual([]);
  });

  it("uses no radius off the scale outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /(?<![\w-])rounded(?:-sm|-3xl|-\[[^\]]*\])?(?![\w-])/g)).toEqual([]);
  });

  it("brings back none of the removed shadow utilities", () => {
    expect(offences(STYLES, /(?<![\w-])(?:surface-shadow|brand-shadow|logo-shadow)(?![\w-])/g)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the consistency tests and clear what they find**

Run: `npx vitest run tests/ui-consistency.test.ts`
Expected: PASS. If a test lists offences, fix each at its source: a raw control becomes its `ui/` primitive; a colour becomes a brand token (`var(--color-…)` in SVG); `rounded` / `rounded-sm` becomes the role's radius from Global Constraints. A match that is not really an offence (a word in a comment, an entry number in text) is fixed by tightening the pattern, never by rewording the source; say which in the report.

- [ ] **Step 5: Update the README's layout entry**

In `README.md`, replace the line `src/components/vx/        Shared light-theme interface primitives and D3` with:

```
src/components/vx/        Vestiarion's domain components — decision cards, the
                           audit ledger, treasury tiles, provenance, D3 charts —
                           built only from src/components/ui
```

(keep the indented entries under it unchanged).

- [ ] **Step 6: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add -A src tests README.md
git commit -m "test(ui): the consistency tests, and the old pieces removed

No raw controls outside src/components/ui, no colour literals, no radius off
the scale, no removed shadow utility. The deprecated vx Card, Label,
SectionHead and Shell EmptyState are gone, and so are the surface-, brand-
and logo-shadow utilities.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 11: Carried polish

**Files:**
- Modify: `src/components/ui/FileInput.tsx`, `src/components/ui/Table.tsx`, `src/components/intake/InvoiceCsvImport.tsx`, `src/components/vx/InsightsCharts.tsx`, `src/components/vx/nav.ts`, `src/components/vx/AppNav.tsx`, `src/components/vx/command-items.ts`, `src/components/MilestoneVerification.tsx`, `src/components/AcceptInvitationByIdForm.tsx`, `src/components/ui/Dialog.tsx`, `src/app/design/Demos.tsx`
- Test: `tests/navigation.test.ts`, `tests/ui-display.test.tsx`

**Interfaces:**
- Produces: `sectionPathOf(pathname: string): string` in `src/components/vx/nav.ts`; `Table` gains an optional `label?: string`.

- [ ] **Step 1: A section's path, written once**

Add to `src/components/vx/nav.ts`:

```ts
/** The section the URL is in, or the workspace's home — where a switch to another workspace lands. */
export function sectionPathOf(pathname: string): string {
  return navItemForPathname(pathname)?.path ?? HOME_PATH;
}
```

Add to `tests/navigation.test.ts`, inside the `navItemForPathname` describe block's file (a new `describe`):

```ts
describe("sectionPathOf", () => {
  it("keeps the section a person is in", () => {
    expect(sectionPathOf("/o/acme/audit/anything-deeper")).toBe("/audit");
  });

  it("falls back to the workspace's home", () => {
    expect(sectionPathOf("/o/acme")).toBe(HOME_PATH);
  });
});
```

(import `sectionPathOf` beside the file's existing imports from `@/components/vx/nav`). Then replace `navItemForPathname(usePathname())?.path ?? HOME_PATH` in `AppNav.tsx` with `sectionPathOf(usePathname())`, and `navItemForPathname(pathname)?.path ?? HOME_PATH` in `command-items.ts` with `sectionPathOf(pathname)`; drop imports that become unused.

- [ ] **Step 2: A file dragged across the drop zone's own text does not flicker it**

In `src/components/ui/FileInput.tsx`, replace `onDragLeave={() => setDragging(false)}` with:

```tsx
      onDragLeave={(event) => {
        // Moving over the zone's own label or icon fires dragleave on the zone; only leaving it counts.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
```

- [ ] **Step 3: A table that scrolls sideways can be scrolled from the keyboard**

In `src/components/ui/Table.tsx`, give `Table` an optional `label`. When set, its frame becomes a named, focusable region:

```tsx
export function Table({ className, containerClassName, label, ...props }: ComponentProps<"table"> & { containerClassName?: string; label?: string }) {
  return (
    <div
      className={cn("relative w-full overflow-x-auto", label && "rounded-lg outline-hidden focus-visible:ring-4 focus-visible:ring-agent-soft", containerClassName)}
      {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
    >
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}
```

Add to the `Table` block of `tests/ui-display.test.tsx`:

```tsx
  it("becomes a named, focusable region when it has a label, so the keyboard can scroll it", () => {
    const markup = html(
      <Table label="Invoices to import">
        <TableBody>
          <TableRow>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Invoices to import"');
    expect(markup).toContain('tabindex="0"');
  });
```

Then pass `label="Invoices to import"` to the preview `<Table …>` in `InvoiceCsvImport.tsx`, and `label={summary}` to the `<Table …>` in `InsightsCharts.tsx`'s `DetailsTable`.

- [ ] **Step 4: Smaller fixes**

- `src/components/MilestoneVerification.tsx`: take `pending` from `useActionForm` (`const { state, pending, formProps } = …`) and give the note `<Input … disabled={disabled || pending} />`, so the note cannot change while it is being recorded.
- `src/components/AcceptInvitationByIdForm.tsx`: the accept button drops `size="sm"` (it sits beside a large avatar; `md` is the size of every other primary action on the onboarding page).
- `src/components/ui/Dialog.tsx`: the close button stays in view when the dialog's content scrolls. Replace its wrapper's classes `className="absolute right-3 top-3"` with `className="sticky top-0 z-10 col-start-1 row-start-1 -mr-2 -mt-2 justify-self-end sm:-mr-3 sm:-mt-3"`, and give the header block `col-start-1 row-start-1` (add to its `cn(...)` list) so the two share the first grid cell — the header keeps its `pr-10`.
- `src/app/design/Demos.tsx`, `OverlayDemo`'s Dialog card: add a second trigger, `A long dialog`, that opens a `DialogContent` titled "A long dialog" whose body is twelve `<p>` paragraphs of the existing description text, so the sticky close button can be checked.

Run: `npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "fix(ui): carried polish from the component work

A section path written once; the drop zone no longer flickers over its own
text; sideways-scrolling tables with a label take keyboard focus; the note
locks while it is recorded; the invitation's accept button is full size; a
dialog's close button stays in view while its content scrolls.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 12: Browser verification (run by the controller)

- [ ] **Step 1:** Start the worktree's dev server (`npx next dev -p 3150` in the background, or reuse it) and verify with headless Edge over CDP when the browser pane is hidden (memory `headless-edge-verification`), at 1280px and 375px, with classic scrollbars and with `prefers-reduced-motion: reduce`.
- [ ] **Step 2 (Review Focus 1, 2):** On `/design#domain`: the six decision cards, one per outcome (settled with receipts, held with a missing receipt, refused with its rule and “no transaction sent”, simulated with no footer, scheduled, recorded with linked evidence); open an audit row — the height animates, the chevron turns, every copy button copies the full value and toasts, long values wrap inside the row at 375px with no horizontal page overflow.
- [ ] **Step 3 (Review Focus 3, 4):** The domain filter's current chip; the insights charts populated (provenance badges say LIVE / SIMULATED / MIXED, legends and bar tracks on the radius scale, receipt tables open and scroll sideways inside themselves and take keyboard focus) and empty (five empty states).
- [ ] **Step 4 (Review Focus 5):** Verify hash chain on `/design` — the request is refused without a session, so the verdict must read “Not checked” in the neutral tone.
- [ ] **Step 5:** The long dialog on `/design#overlays` keeps its close button in view while scrolled; the drop zone does not flicker while a file is dragged across its text.
- [ ] **Step 6:** No console errors or hydration warnings on `/`, `/login`, `/design`; stop the dev server afterwards if this task started it. The workspace pages themselves are checked by the partner after deploy (they sit behind sign-in).
