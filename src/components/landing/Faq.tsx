import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { ISSUES_URL } from "@/lib/site-links";
import { landingPrefetch } from "./prefetch";

const link = "font-medium text-agent underline-offset-4 hover:underline";

/** A docs page an answer points to, after its last sentence. */
function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <>
      {" "}
      <Link href={href} prefetch={landingPrefetch(href)} className={link}>
        {children}
      </Link>
    </>
  );
}

/**
 * The questions a business asks before it trusts Vestiarion with its bills (docs/superpowers/specs/2026-10-11-landing-
 * clarity-design.md F1), in the order an owner or a finance person asks them: can I try it safely, who controls the money,
 * what pays on its own, what happens when a payment fails, whether it fits their tools, whether they need crypto, what
 * it costs and who sees their bills. Each is answered as the product behaves today. Cost is answered as it stands:
 * trying it is free and there is no published price yet; a live payment carries only its network fee.
 * `mainnetForEveryone` is whether this deployment opens Arc mainnet to every account, so the first answer does not
 * promise a workspace there to someone it is not open to.
 */
export function landingFaq(mainnetForEveryone: boolean): ReadonlyArray<{ question: string; answer: ReactNode }> {
  return [
    {
      question: "Can I try Vestiarion without real money?",
      answer: (
        <>
          Yes. In shadow mode you keep paying the way you do today and agree or disagree with each of the agent&apos;s decisions on your real
          bills: nothing is paid until a person agrees, unless you let the agent pay vendors that earned it under your rule, on Arc testnet. No
          wallet or funds are needed. A workspace runs on Arc testnet, where test USDC has
          no market value, or on Arc mainnet, where payments move real USDC
          {mainnetForEveryone ? "." : ", for the accounts it is open to so far."}
          <More href="/docs/guides/try-it">See your first decision in five minutes</More>
        </>
      ),
    },
    {
      question: "Who controls the money and approves payments?",
      answer: (
        <>
          You do. The AI proposes each payment, rules in code check it against your limits before anything moves, and what they stop waits for
          a person in Approvals; a first payment to a new address always needs two people. You can pause the agent at any time, and on Arc
          mainnet money leaves only through a spending-limit contract your own wallet deploys.
          <More href="/docs/guides/controls">How payments are controlled</More>
        </>
      ),
    },
    {
      question: "Can Vestiarion pay bills and contractors automatically?",
      answer:
        "Yes, in a live workspace: a bill, or a contractor milestone whose work is verified, that passes every check and fits your limits is paid on its own, on the day the agent picks. Anything else, such as a bill above its payee's limit or a first payment to a new address, waits for a person in Approvals. In shadow mode nothing is paid until someone agrees, unless the owner lets the agent pay vendors that earned it under their rule, on Arc testnet.",
    },
    {
      question: "What happens if a payment fails?",
      answer: (
        <>
          Nothing is paid twice. Before anything is sent again, Vestiarion checks the earlier transfer with Circle, only a person can send a new
          one, and the bill&apos;s card says who acts and what to do next. A transfer confirmed on Arc is final and cannot be reversed: a refund
          is a new payment back from the payee.
          <More href="/docs/guides/payment-exceptions">When a payment does not go through</More>
        </>
      ),
    },
    {
      question: "Does Vestiarion work with my existing tools?",
      answer:
        "Yes. Bills come in from Xero, QuickBooks Online or Zoho Books for you to review, or by form, PDF, a bill list from your spreadsheet, email, Telegram or the API. Won deals come in from HubSpot, Pipedrive or Zoho CRM to plan their collections. Contractor work delivered in Asana is paid once a person accepts it against its criteria. Your team sees the agent's decisions in Slack or Telegram.",
    },
    {
      question: "Do I need crypto or a wallet to get started?",
      answer:
        "No. Shadow mode needs no wallet and no USDC. A wallet and USDC matter only once you want the agent to pay bills itself; the people you pay then need an address on Arc, and someone new gets a one-time link to add theirs, with no account to make.",
    },
    {
      question: "What does Vestiarion cost?",
      answer:
        "Trying it is free, and there is no published price yet. Shadow mode needs no wallet and no funds. Once the agent pays bills itself, each payment carries only its network fee, in USDC: on Arc, less than a cent. A payout to another chain carries that chain's transfer fee too.",
    },
    {
      question: "Who can see our bills?",
      answer: (
        <>
          The members of your workspace. To decide on a bill, the agent sends its facts to the AI model provider this deployment uses. Public pages
          count workspaces and payments, never a workspace&apos;s name, a bill or a payee.
          <More href="/privacy">What we store and who sees it</More>
        </>
      ),
    },
  ];
}

/** The plus that loses its upright bar, and so reads as a minus, while its question is open. */
function PlusMinus() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-1 size-4 shrink-0 text-ink-3 transition-colors duration-150 ease-standard group-hover/faq:text-agent">
      <path d="M2.5 8h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M8 2.5v11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="origin-center transition-transform duration-200 ease-standard [transform-box:fill-box] group-open/disclosure:scale-y-0"
      />
    </svg>
  );
}

export function Faq({ mainnetForEveryone }: { mainnetForEveryone: boolean }) {
  return (
    <Section id="faq" tone="surface" aria-labelledby="faq-title" className="scroll-mt-16 border-b border-line" containerClassName="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        {/* On a wide screen the heading stays in view beside the questions; below that it scrolls with the page. */}
        <div className="max-w-md lg:sticky lg:top-24 lg:self-start">
          <Eyebrow className="text-agent">Questions</Eyebrow>
          <Heading id="faq-title" className="mt-3 max-w-4xl text-balance">
            Everything you need to know.
          </Heading>
          <p className="mt-4 text-pretty text-[0.9375rem] leading-relaxed text-ink-2">
            From your first bill to your first payment, here&apos;s how Vestiarion works.
          </p>
          <p className="mt-6">
            <Link href="/docs" prefetch={false} className={`inline-flex min-h-11 items-center gap-1 text-[0.9375rem] ${link}`}>
              Explore the docs
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </p>
          <div className="mt-6 border-t border-line pt-5">
            <p className="text-sm text-ink-2">Still have questions?</p>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={`inline-flex min-h-11 items-center gap-1 text-sm ${link}`}>
              Talk to the founder on GitHub
              <ArrowUpRight aria-hidden className="size-4" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </div>
        <div className="min-w-0 divide-y divide-line border-y border-line">
          {landingFaq(mainnetForEveryone).map((item) => (
            <Disclosure
              key={item.question}
              name="landing-faq"
              variant="bare"
              summary={
                <span className="flex min-h-11 items-start justify-between gap-6 py-5">
                  <h3 className="text-pretty text-base font-semibold leading-snug text-ink transition-colors duration-150 ease-standard group-hover/faq:text-agent">
                    {item.question}
                  </h3>
                  <PlusMinus />
                </span>
              }
              summaryClassName="group/faq block"
              contentClassName="max-w-[62ch] pb-6 text-[0.9375rem] leading-7 text-ink-2 sm:pr-10"
            >
              {item.answer}
            </Disclosure>
          ))}
        </div>
    </Section>
  );
}
