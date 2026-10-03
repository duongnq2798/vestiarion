import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { ISSUES_URL } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Vestiarion stores, which services receive it, how long it is kept, and how to delete it.",
  alternates: { canonical: "/privacy" },
};

/**
 * The privacy page (spec §2, F2). Static and public. Every statement is what
 * the code does today; `tests/legal-pages.test.tsx` reads the numbers and
 * settings it quotes (the cleanup's thresholds, the roles, the analytics
 * redaction, the hashing, the cipher, the tombstone's columns) from the code.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="2026-09-30"
      intro="Vestiarion is an autonomous treasury agent on Arc testnet. This page describes what the service stores and sends, as its code does it today. The code is public, so every statement here can be checked against it."
    >
      <LegalSection id="signing-in" title="Signing in">
        <p>
          You sign in with your email address: Supabase Auth emails you a one-time sign-in link, and there is no password. Where Google sign-in is turned on,
          you can use your Google account instead, and Supabase Auth receives your Google account&apos;s basic profile, including your email address. Your
          account is kept by Supabase Auth.
        </p>
        <p>
          Signing in sets cookies that keep your session. When a sign-in link should take you somewhere other than the default page, such as an invitation,
          one more cookie remembers where, for up to an hour.
        </p>
      </LegalSection>

      <LegalSection id="workspace-data" title="What a workspace stores">
        <p>A workspace holds what its members and its agent put into it:</p>
        <ul>
          <li>invoices, with their amounts, memos, purchase order references and due dates;</li>
          <li>counterparties: their names, wallet addresses, screening results and payment limits, and the email address for payment notices when a member gives one;</li>
          <li>contractor milestones, with any GitHub pull request link used to verify one;</li>
          <li>the agent&apos;s settings and its treasury records;</li>
          <li>its members and their roles, and open invitations with the invited email addresses;</li>
          <li>API keys and webhook endpoints;</li>
          <li>the ledger: every decision the agent makes, with its reasoning, signed with Ed25519 and chained by hash.</li>
        </ul>
        <p>
          It is stored in a Supabase Postgres database. Each request for a workspace&apos;s data runs as a database role that row-level security limits to
          that one workspace, so one workspace cannot read another&apos;s rows.
        </p>
      </LegalSection>

      <LegalSection id="roles" title="Who can see what">
        <p>
          Only a workspace&apos;s members, and the API keys and webhook endpoints they set up, reach its data. Every member can see all of it; what a member
          can do depends on their role:
        </p>
        <ul>
          <li>
            <strong>viewer</strong>: reads the workspace;
          </li>
          <li>
            <strong>approver</strong>: also decides the payments the agent held, and pauses the agent;
          </li>
          <li>
            <strong>admin</strong>: also adds records, runs and resumes the agent, and manages members, API keys and webhooks;
          </li>
          <li>
            <strong>owner</strong>: also connects Circle, and can delete the workspace.
          </li>
        </ul>
        <p>Nobody can approve an invoice they created. The service&apos;s own scheduled jobs, such as the agent&apos;s cycles and the cleanup below, work across workspaces.</p>
        <p>
          The public <LegalLink href="/open">open numbers</LegalLink> page shows counts and totals across all workspaces, such as how many payments settled
          and how much USDC they moved. It never names a workspace or a person, and never lists a customer&apos;s payment.
        </p>
        <p>
          An owner or admin can share one paid payment&apos;s receipt as a link. Anyone with the link sees that payment&apos;s amount, the payee&apos;s
          chain and address, its transactions and its signed ledger entry, which already sit on a public chain or in the workspace&apos;s own ledger. It
          shows no names. The link stops working when they stop sharing it or make a new one.
        </p>
      </LegalSection>

      <LegalSection id="secrets" title="Secrets">
        <p>
          The Circle API key and entity secret you connect, each webhook endpoint&apos;s signing secret, and each workspace&apos;s ledger signing key are
          encrypted with AES-256-GCM under the platform&apos;s master key before they are stored. Each is bound to its workspace and its field, so a copy moved
          into another row does not decrypt.
        </p>
        <p>An API key is shown once, when it is created. Vestiarion keeps its prefix and a SHA-256 hash of its secret, never the secret itself.</p>
      </LegalSection>

      <LegalSection id="wallets" title="Wallets and payments">
        <p>
          Payments are USDC or EURC transfers on Arc testnet through Circle Developer-Controlled Wallets. A workspace that connects its own Circle account keeps its
          wallets in that account. A workspace that chooses hosted wallets has them created in Vestiarion&apos;s own Circle testnet account, so Vestiarion
          holds them; you fund them from Circle&apos;s faucet.
        </p>
        <p>
          Payee history: anyone who pays for it over x402 can ask, for one Arc address, how many workspaces here have paid it with live payments, how many such
          payments were confirmed, and when the first and the last were made. The answer names no workspace and no amount. A workspace&apos;s agent can buy the
          same answer before its first payment to an address, from a service budget a person gives it.
        </p>
      </LegalSection>

      <LegalSection id="services" title="Services that receive data">
        <ul>
          <li>
            <strong>Vercel</strong> hosts the app.
          </li>
          <li>
            <strong>Supabase</strong> holds the database and runs sign-in.
          </li>
          <li>
            <strong>Circle</strong> creates the wallets and moves the payments, through Developer-Controlled Wallets, CCTP, Gateway and its Smart Contract Platform, so it receives wallet addresses and payment amounts. Its Stablecoin Service quotes EURC in USDC and builds the swaps of USDC for EURC, so it receives the operating wallet&apos;s address and the amounts. Gateway also verifies and settles the x402 payments for payee history, so it receives each signed payment: the paying wallet, the payee and the amount.
          </li>
          <li>
            <strong>Resend</strong> sends transactional email: invitations to a workspace, digests of the payments waiting for a decision, the link a payee
            adds their address through, and payment notices to a payee once a live workspace&apos;s payment to them is confirmed. It receives each
            recipient&apos;s email address and the message.
          </li>
          <li>
            <strong>A model provider</strong>, when this deployment has one configured (Anthropic, OpenAI or DeepSeek), receives the context of each decision
            the agent asks it about, and nothing else:
            <ul>
              <li>
                for an invoice: its amount and currency, its value in USDC for an invoice in EURC, memo, purchase order reference, due date, early-payment discount and
                whether the goods were received, and, for one a recurring payment created, its period and how often it repeats; the counterparty&apos;s name, risk level, payment limit and performance score, and, when the agent bought it before a first payment, how many workspaces here have paid its address, how often, and when first and last; the operating balance and the reserve
                balance, or for an invoice in EURC the wallet&apos;s EURC balance, its USDC balance and the USDC due within 7 days, and, when its EURC falls short,
                the swap of USDC for EURC that could fund it (the USDC it takes, the EURC it gives at least and as estimated, and what it costs above the
                quoted rate), or why there is none; how the payee is paid, on Arc or across chains through CCTP or a Gateway balance with its fee
                and expected time; the payment timing worked out from those:
                today&apos;s date and the due date, what the discount is worth and the last day it applies, the yield from keeping the cash to the due date,
                the day the written policy would pay on and the amount due that day, the total and number of payments that fall due on or before that day,
                and whether the cash available by that day falls short of covering this invoice after them; when the agent scheduled the invoice earlier, the date it
                chose and its reasoning; and any earlier invoices from the same
                counterparty that look like duplicates of it, each with its amount, due date and status, the signals that matched, how strong the match is
                and what the match found;
              </li>
              <li>
                for a contractor milestone: its title, amount and verification source, how it was verified (whether, by what method, and the verifier&apos;s note), and the contractor&apos;s name, risk level, payment limit and
                performance score, and, when the agent bought it before a first payment, how many workspaces here have paid its address, how often, and when first and last;
              </li>
              <li>
                for an invoice document a member chooses to read (a PDF, an email or pasted text): the document&apos;s text, up to 20,000 characters, to read
                its vendor, amounts, dates, terms and payment address into the invoice form. The document itself is not kept;
              </li>
              <li>
                for a proposed payment limit: the counterparty&apos;s name, limit, risk level and performance score, and each payment people approved above
                that limit in the last 30 days (its amount, when, and what the agent had done with it), with how many were rejected;
              </li>
              <li>
                for a treasury move: the operating and reserve balances, the reserve&apos;s yield, the obligations due in the next 7 and 14 days, the total open
                obligations and the days until the next one is due, and the sweep&apos;s economics worked out from those: the cash above the required buffer, how
                long it could stay swept, the projected yield and the cost of the transfers; and, for a real USYC reserve, that it is real and whether USYC
                can be bought now.
              </li>
            </ul>
            A performance score comes with the counts it is computed from: payments paid without intervention, information requests, holds and flags,
            duplicate submissions, risk tier changes, and the holds the workspace&apos;s own limits caused. Without a model provider, a written rule-based policy
            decides, and nothing is sent.
          </li>
          <li>
            <strong>OpenSanctions</strong>, when this deployment has it configured, receives the names and jurisdictions of a live workspace&apos;s
            counterparties to screen them. A sandbox, and any workspace on a deployment without it, checks names against a list built into the app and sends
            them nowhere.
          </li>
          <li>
            <strong>GitHub</strong> is asked for a pull request&apos;s status when a milestone is verified by its link.
          </li>
          <li>
            <strong>Google Analytics</strong> receives page views, as described below.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="analytics" title="Analytics">
        <p>When this deployment sets a measurement ID, Vestiarion counts page views with Google Analytics 4. Before a page view leaves your browser:</p>
        <ul>
          <li>
            an invitation address becomes <code>/invite/:token</code>, a payee link <code>/payee/:token</code> and a receipt link{" "}
            <code>/receipt/:token</code>, and a workspace address has the workspace&apos;s slug replaced, as <code>/o/:org</code>;
          </li>
          <li>only the path is sent, never the query string or anything after a #;</li>
          <li>the title of a workspace page, which names the workspace, is replaced with its redacted path;</li>
          <li>a referrer on this site is redacted the same way, and a referrer from another site is cut to its origin.</li>
        </ul>
        <p>Google signals and ad personalization signals are turned off. Google Analytics sets its own cookies to tell visits apart.</p>
      </LegalSection>

      <LegalSection id="retention" title="How long data is kept">
        <ul>
          <li>
            A sandbox workspace with no activity for 60 days is deleted by a daily cleanup. A sandbox is kept if Circle credentials are connected to it, or if
            it holds a hosted wallet.
          </li>
          <li>A webhook delivery is deleted 30 days after it is delivered; one that failed, 30 days after it was created.</li>
          <li>Everything else in a workspace is kept until the workspace is deleted.</li>
        </ul>
      </LegalSection>

      <LegalSection id="delete-workspace" title="Deleting a workspace">
        <p>
          An owner can delete a workspace from its Settings, typing its slug to confirm. A live workspace&apos;s agent has to be paused first, and deletion
          waits while a cycle is running or a payment is being made.
        </p>
        <p>
          Deletion removes the workspace&apos;s invoices, counterparties, milestones, treasury records, ledger, API keys, webhooks, members and invitations, in
          one step, for everyone in it, and cannot be undone. Vestiarion keeps a tombstone that only the platform can read: the workspace&apos;s slug and name,
          who deleted it and when, and its ledger&apos;s length, head hash and signing key id.
        </p>
        <p>
          The workspace&apos;s wallets stay in the Circle account that holds them, with any USDC in them. For hosted wallets, that is Vestiarion&apos;s testnet
          account.
        </p>
      </LegalSection>

      <LegalSection id="delete-account" title="Deleting your account">
        <p>
          <strong>Delete account</strong> is in the menu under your email address, beside Sign out, and on the workspaces page. It needs no workspace role. Its
          dialog lists what will happen before anything does, and you type <code>delete my account</code> to confirm.
        </p>
        <ul>
          <li>
            A workspace where you are the only member is deleted with your account, as an owner deletes one from Settings, so the same rules apply: a live
            workspace&apos;s agent has to be paused first, and deletion waits while a cycle is running or a payment is being made. Each leaves its tombstone.
          </li>
          <li>
            If you are the last owner of a workspace that has other members, your account cannot be deleted until you make someone else an owner, or delete the
            workspace. Your teammates never lose a workspace because you left.
          </li>
          <li>If you are the last owner of the founding workspace, your account cannot be deleted.</li>
          <li>In a workspace with another owner, or where you are not an owner, only your membership goes.</li>
        </ul>
        <p>
          If a workspace cannot be deleted, your account is not deleted. Otherwise your sign-in account is deleted, you are signed out, and your memberships and
          the invitations you sent go with it. Records you added in workspaces you share stay, without your name on them. A workspace&apos;s signed ledger is
          append-only, so entries you caused keep your account&apos;s id (never your email). A workspace deleted with your account leaves its tombstone, and a
          tombstone keeps who deleted it, as your account&apos;s id.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions and requests go to <LegalLink href={ISSUES_URL}>GitHub Issues</LegalLink>. The <LegalLink href="/terms">Terms of use</LegalLink> cover
          using the service.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
