import Link from "next/link";
import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";

/**
 * The questions a team asks before it tries Vestiarion (docs/superpowers/specs/2026-10-11-landing-clarity-design.md F1),
 * answered as the product behaves today. Cost is left out on purpose: there is no published price to answer it with.
 * `mainnetForEveryone` is whether this deployment opens Arc mainnet to every account, so the answer about real money
 * does not promise a workspace there to someone it is not open to.
 */
export function landingFaq(mainnetForEveryone: boolean): ReadonlyArray<{ question: string; answer: ReactNode }> {
  const link = "font-medium text-agent underline-offset-4 hover:underline";
  return [
    {
      question: "Do I need crypto to try it?",
      answer:
        "No. In shadow mode you keep paying the way you do today. You add your real bills, see what the agent decides, and agree or disagree. No wallet or funds are needed to start; USDC matters only once you want the agent to pay bills itself.",
    },
    {
      question: "Do the people I pay need a crypto wallet?",
      answer:
        "Only once the agent pays them itself: a payee then needs an address on Arc. Someone new gets a link to enter theirs, with no account to make. In shadow mode on Arc testnet, a payee with no address can be given one that Vestiarion makes for them.",
    },
    {
      question: "Can it pay contractors automatically?",
      answer:
        "Yes, in a live workspace. A bill that passes every check and fits your limits is paid on its own, on the day the agent picks; anything else waits for a person in Approvals. In shadow mode nothing is paid until someone agrees.",
    },
    {
      question: "Does it fit how we already work?",
      answer:
        "Bills come in by form, PDF, a bill list from your spreadsheet, email, Telegram or the API, or from Xero and QuickBooks Online for you to review. Won deals come in from HubSpot to plan their collections. Contractor work delivered in Asana is paid once a person accepts it against its criteria. Your team sees the agent's decisions in Slack or Telegram, and can pause it from Slack. Developers get a REST API, a TypeScript SDK and webhooks.",
    },
    {
      question: "Is it live with real money?",
      answer: (
        <>
          {mainnetForEveryone
            ? "Yes. Anyone can open a workspace on Arc mainnet, which pays real USDC within a daily and a 7-day spending limit that always applies there."
            : "Yes, for the accounts it is open to so far: a workspace on Arc mainnet pays real USDC within a daily and a 7-day spending limit that always applies there."}{" "}
          Payouts to other chains, the USYC reserve, the EURC swap and escrow run on Arc testnet only for now.{" "}
          <Link href="/open#mainnet" className={link}>
            See the payments on Arc mainnet
          </Link>
        </>
      ),
    },
    {
      question: "What do testnet and mainnet mean?",
      answer:
        "Arc is the network the payments settle on. Arc testnet is its test network: its USDC has no market value, so you can try everything, real transactions included, without risk. Arc mainnet is the live network, with real USDC.",
    },
    {
      question: "Who can see our bills?",
      answer: (
        <>
          The members of your workspace. To decide on a bill, the agent sends its facts to the AI model provider this deployment uses. Public pages
          count workspaces and payments, never a workspace&apos;s name, a bill or a payee.{" "}
          <Link href="/privacy" className={link}>
            What we store and who sees it
          </Link>
        </>
      ),
    },
  ];
}

export function Faq({ mainnetForEveryone }: { mainnetForEveryone: boolean }) {
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-16 border-b border-line bg-surface">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-14">
        <div className="max-w-md">
          <Eyebrow className="text-agent">Questions</Eyebrow>
          <h2 id="faq-title" className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-4xl">
            What teams ask before they try it.
          </h2>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
            Something else?{" "}
            <Link href="/docs" className="font-medium text-agent underline-offset-4 hover:underline">
              The docs
            </Link>{" "}
            go step by step, screen by screen.
          </p>
        </div>
        <div className="grid min-w-0 gap-2.5">
          {landingFaq(mainnetForEveryone).map((item) => (
            <Disclosure
              key={item.question}
              summary={<h3 className="text-[0.9375rem] font-semibold text-ink">{item.question}</h3>}
              summaryClassName="py-3.5"
              contentClassName="px-4 pb-4 pl-10 text-[0.9375rem] leading-relaxed text-ink-2"
            >
              {item.answer}
            </Disclosure>
          ))}
        </div>
      </div>
    </section>
  );
}
