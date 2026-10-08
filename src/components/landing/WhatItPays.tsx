import { ArrowRight, Check, GitMerge } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";

/**
 * What the agent pays (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L3): the kinds of payment a
 * business hands it, each said as its guide says it, with a small illustration and the guide that says how it decides.
 * The illustrations are examples; the steps, checks and rules are the agent's own.
 */

export interface PaysForCard {
  key: "bills" | "contractors" | "bounties" | "recurring" | "chains" | "eurc";
  title: string;
  body: string;
  /** What is checked before it is paid, a few words each. */
  checks: string[];
  /** The guide, and the heading in it, that says how the agent decides it. */
  href: string;
}

export const PAYS_FOR: PaysForCard[] = [
  {
    key: "bills",
    title: "Supplier bills",
    body: "Forward a bill by email or drop in a PDF. The agent matches it to its purchase order and receipt, and pays it on the discount's last day or on its due date.",
    checks: ["Purchase order", "Goods received", "Payee's limit"],
    href: "/docs/guides/first-payment#5-when-the-agent-pays",
  },
  {
    key: "contractors",
    title: "Freelancers and contractors",
    body: "Pay for work once it is delivered: a design approved, a pull request merged. Someone new gets a link to say where they want to be paid.",
    checks: ["Work verified", "Address confirmed", "Screened"],
    href: "/docs/guides/pay-a-contractor",
  },
  {
    key: "bounties",
    title: "Bounties on pull requests",
    body: "Comment /bounty 25 on a pull request. Once it is merged, the agent pays its author, and the payment's transaction is posted on the pull request.",
    checks: ["Merged on GitHub", "Author's address", "Daily limit"],
    href: "/docs/guides/github#3-attach-a-bounty-from-a-comment",
  },
  {
    key: "recurring",
    title: "Retainers and subscriptions",
    body: "Set it up once. Each week or month becomes a bill of its own, and the agent picks the day to pay it, never later than it is due.",
    checks: ["One bill a period", "Never taken for a repeat"],
    href: "/docs/guides/first-payment#pay-something-every-period",
  },
  {
    key: "chains",
    title: "Payees on other chains",
    body: "A vendor who wants USDC on Base, Arbitrum or Ethereum Sepolia is paid from Arc through CCTP, or from a Circle Gateway balance when that costs less.",
    checks: ["Fee weighed", "Held above 10% of the bill"],
    href: "/docs/guides/first-payment#pay-a-payee-on-another-chain",
  },
  {
    key: "eurc",
    title: "Bills in euros",
    body: "A bill in EURC is paid in EURC. When the wallet is short of it, the agent can swap USDC for it through Circle, within a 3% cost cap.",
    checks: ["USDC value within the limit", "Swap cost cap"],
    href: "/docs/guides/first-payment#invoices-in-eurc",
  },
];

const GET_PAID = "/docs/guides/first-payment#9-get-paid-by-a-client";

/** A small piece of interface, as the illustrations draw them. */
function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "proof" | "agent" }) {
  const tones = {
    neutral: "border-line bg-surface text-ink-2",
    proof: "border-proof-line bg-proof-soft text-proof",
    agent: "border-agent-line bg-agent-soft text-agent",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] font-medium ${tones[tone]}`}>{children}</span>;
}

function Tick() {
  return <Check className="size-3 shrink-0 text-proof" strokeWidth={3} />;
}

function Vignette({ kind }: { kind: PaysForCard["key"] }) {
  switch (kind) {
    case "bills":
      return (
        <div className="w-full max-w-[15rem] rounded-lg border border-line bg-surface p-3 shadow-surface">
          <div className="flex items-baseline justify-between gap-2 font-mono text-[0.6875rem] text-ink-3">
            <span>INV-204</span>
            <span className="text-sm font-semibold text-ink">12.50 USDC</span>
          </div>
          <div className="mt-2 grid gap-1 text-xs text-ink-2">
            <span className="flex items-center gap-1.5">
              <Tick /> Purchase order PO-204
            </span>
            <span className="flex items-center gap-1.5">
              <Tick /> Goods received
            </span>
          </div>
          <div className="mt-2.5">
            <Chip tone="agent">Pay Oct 10 · 2% off</Chip>
          </div>
        </div>
      );
    case "contractors":
      return (
        <div className="flex w-full max-w-[16rem] items-center gap-2">
          <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-2.5 shadow-surface">
            <p className="truncate text-xs font-medium text-ink">Logo design</p>
            <p className="mt-1 flex items-center gap-1 text-[0.6875rem] text-proof">
              <Tick /> Approved
            </p>
          </div>
          <ArrowRight className="size-4 shrink-0 text-ink-3" />
          <Chip tone="proof">0.30 USDC</Chip>
        </div>
      );
    case "bounties":
      return (
        <div className="grid w-full max-w-[15rem] gap-1.5">
          <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink shadow-surface">/bounty 25</div>
          <div className="flex items-center justify-between gap-2">
            <Chip tone="agent">
              <GitMerge className="size-3" /> Merged
            </Chip>
            <Chip tone="proof">Paid 25 USDC</Chip>
          </div>
        </div>
      );
    case "recurring":
      return (
        <div className="grid w-full max-w-[15rem] grid-cols-3 gap-1.5 text-center">
          {[
            ["Oct", "31", true],
            ["Nov", "30", false],
            ["Dec", "31", false],
          ].map(([month, day, paid]) => (
            <div key={month as string} className="rounded-lg border border-line bg-surface py-1.5 shadow-surface">
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-ink-3">{month}</p>
              <p className="text-base font-semibold text-ink">{day}</p>
              <p className="flex justify-center">{paid ? <Tick /> : <span className="size-1.5 rounded-full bg-line-strong" />}</p>
            </div>
          ))}
        </div>
      );
    case "chains":
      return (
        <div className="grid w-full max-w-[16rem] gap-2">
          <div className="flex items-center gap-2">
            <Chip>Arc testnet</Chip>
            <span className="h-px flex-1 bg-line-strong" />
            <Chip>Base Sepolia</Chip>
          </div>
          <div className="flex justify-center">
            <Chip tone="agent">CCTP · fee 0.05 USDC</Chip>
          </div>
        </div>
      );
    case "eurc":
      return (
        <div className="grid w-full max-w-[15rem] gap-2 text-center">
          <p className="text-xl font-semibold tracking-[-0.02em] text-ink">
            120.00 <span className="text-sm font-medium text-ink-3">EURC</span>
          </p>
          <div className="flex justify-center">
            <Chip tone="agent">swap 131.20 USDC · cap 3%</Chip>
          </div>
        </div>
      );
  }
}

export function WhatItPays() {
  return (
    <section id="what-it-pays" aria-labelledby="what-it-pays-title" className="border-b border-line">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-3xl">
          <Eyebrow className="text-agent">What the agent pays</Eyebrow>
          <h2 id="what-it-pays-title" className="mt-4 text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-5xl">
            Bills, contractors, bounties. One agent, the same checks.
          </h2>
          <p className="mt-4 text-pretty font-serif text-lg leading-relaxed text-ink-2 sm:text-xl">
            Each payment passes screening, the payee&apos;s limit, a confirmed address and your spending limit before money moves on Arc testnet, and each
            decision is signed into the ledger.
          </p>
        </div>
        <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PAYS_FOR.map((card) => (
            <li key={card.key} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-surface">
              <div aria-hidden className="ledger-grid grid h-36 place-items-center rounded-xl border border-line/70 bg-ground/70 px-4">
                <Vignette kind={card.key} />
              </div>
              <h3 className="mt-4 text-base font-semibold text-ink">{card.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{card.body}</p>
              <ul aria-label="Checked before it is paid" className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                {card.checks.map((check) => (
                  <li key={check} className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-ink-3">
                    <Check aria-hidden className="size-3 shrink-0 text-proof" strokeWidth={3} />
                    {check}
                  </li>
                ))}
              </ul>
              <Link
                href={card.href}
                aria-label={`How it decides: ${card.title}`}
                className="mt-auto inline-flex items-center gap-1 self-start pt-4 text-sm font-medium text-agent underline-offset-2 hover:underline"
              >
                How it decides
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-pretty text-[0.9375rem] leading-relaxed text-ink-2">
          It gets you paid too: a pay link for each client invoice, matched when the money arrives, and reminders the agent times.{" "}
          <Link href={GET_PAID} className="font-medium text-agent underline-offset-2 hover:underline">
            Get paid by a client
          </Link>
        </p>
        <p className="mt-3 text-xs text-ink-3">Illustrations with example payees and amounts. The steps, checks and rules are the agent&apos;s own.</p>
      </div>
    </section>
  );
}
