import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { HOSTED_MODEL_PROVIDER } from "@/lib/connectors/consent";
import { ISSUES_URL } from "@/lib/site-links";
import { ARC_RPC_HOSTS, ENS_GATEWAY_HOSTS, ENS_RPC_HOST, listed, MODEL_PROVIDER_TERMS, PAYEE_CHAIN_RPC_HOSTS } from "@/lib/subprocessors";

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
      updated="2026-10-23"
      intro="Vestiarion is an AI agent for bills and payments on Arc mainnet and Arc testnet. This page describes what the service stores and sends, as its code does it today. The code is public, so every statement here can be checked against it."
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
        <p>
          When you fold or unfold the sidebar in a workspace, your browser keeps that choice in a first-party cookie, <code>vx_sidebar</code>, for a year, so
          the next page opens the same way. It holds only the word <code>collapsed</code> or <code>expanded</code>: Vestiarion reads it to draw the page, and it goes nowhere else.
        </p>
      </LegalSection>

      <LegalSection id="workspace-data" title="What a workspace stores">
        <p>A workspace holds what its members and its agent put into it:</p>
        <ul>
          <li>invoices, with their amounts, memos, purchase order references and due dates;</li>
          <li>
            counterparties: their names, wallet addresses, screening results and payment limits, and their billing email when a member gives one, where
            payment notices, reminders, the agent&apos;s early-payment offers, its discounts for paying early, its requests for more time, its requests for a
            bill&apos;s missing document and the question whether they changed their payment address go;
          </li>
          <li>
            the documents vendors send through a request&apos;s link for a bill&apos;s missing purchase order or goods receipt: the file, its SHA-256, kind
            and size, and the purchase order number and note the vendor typed, described below;
          </li>
          <li>contractor milestones, with any GitHub pull request link used to verify one;</li>
          <li>the agent&apos;s settings and its treasury records;</li>
          <li>its members and their roles, and open invitations with the invited email addresses;</li>
          <li>
            for each member, the steps of their getting-started checklist that nothing else records, and when: that they opened Approvals or the
            accountant console, kept the agent&apos;s limits as they were, or hid their checklist; these go with the workspace, and with the
            member&apos;s account;
          </li>
          <li>API keys and webhook endpoints;</li>
          <li>the ledger: every decision the agent makes, with its reasoning, signed with Ed25519 and chained by hash;</li>
          <li>
            what the workspace used each month: the agent&apos;s model calls with the tokens they used, Circle transfers, x402 purchases, emails and
            connector syncs, each with its count and cost where known, and never who it was for or what an email said;
          </li>
          <li>
            what a customer sends on its statement link: the day it says it paid, a payment reference and an amount when it gives them, the day it
            promises to pay, and the messages it and the workspace&apos;s members write to each other about an invoice.
          </li>
        </ul>
        <p>
          It is stored in a Supabase Postgres database. Each request for a workspace&apos;s data runs as a database role that row-level security limits to
          that one workspace, so one workspace cannot read another&apos;s rows.
        </p>
      </LegalSection>

      <LegalSection id="client-links" title="An accountant's client links">
        <p>
          An accountant can send a new client a one-time link from the accountant console, so the client opens their own workspace with the accountant
          in it. Before the link is used, it belongs to no workspace. What Vestiarion keeps of it:
        </p>
        <ul>
          <li>who made it, as their account&apos;s id;</li>
          <li>the client&apos;s email address, only when the accountant gives one, so the link works for that address alone;</li>
          <li>the SHA-256 hash of the link, never the link itself, which is shown to the accountant once;</li>
          <li>when it was made, when it expires (7 days later), and when it was used or revoked;</li>
          <li>the workspace it opened, once used.</li>
        </ul>
        <p>
          Only the accountant who made a link sees it, on their console, with the workspace it opened while they are still a member of it. The link&apos;s
          page shows nothing before you sign in; then it shows the accountant&apos;s sign-in email address, so you know who will see your workspace. A link
          goes with the account of the accountant who made it. A workspace deleted later leaves the link marked used, naming no workspace.
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
            <strong>owner</strong>: also connects Circle, and can delete the workspace;
          </li>
          <li>
            <strong>accountant</strong>: reads the workspace as a viewer does, and books payments in the workspace&apos;s accounting tool, applies money
            received, checks vendors&apos; statements and answers customers, but decides no payment; an accountant&apos;s console lists only the workspaces they are a member of, and
            stops listing one when they are removed from it.
          </li>
        </ul>
        <p>Nobody can approve an invoice they created. The service&apos;s own scheduled jobs, such as the agent&apos;s cycles and the cleanup below, work across workspaces.</p>
        <p>
          The public <LegalLink href="/open">open numbers</LegalLink> page shows counts and totals across all workspaces, such as how many payments settled
          and how much USDC they moved. It never names a workspace or a person, and never lists a customer&apos;s payment.
        </p>
        <p>
          An owner or admin can share one paid payment&apos;s receipt as a link. Anyone with the link sees that payment&apos;s amount, its fees, the
          invoice&apos;s number if it has one, the payee&apos;s chain and address, its transactions and its signed ledger entry, which already sit on a
          public chain or in the workspace&apos;s own ledger. It shows no names. The link stops working when they stop sharing it or make a new one.
        </p>
        <p>
          An owner or admin can also share the workspace&apos;s report as a link, choosing whether it shows suppliers&apos; names or labels, amounts or
          not, and the workspace&apos;s name or a neutral title. Anyone with the link sees a live copy: the figures, the agent&apos;s decisions with the
          first sentence of its reasoning, and the payments with their transactions, which are not linked when amounts are hidden. It never shows memos, notes, references, invoice ids, or the names
          and emails of the workspace&apos;s members, and it hides any purchase order reference or memo the agent&apos;s sentence quotes. The link stops working when they stop sharing it, and the workspace&apos;s members see every live
          link.
        </p>
        <p>
          An owner or admin can send a customer a link to its own statement. Anyone with the link sees, until it expires or is stopped, that
          customer&apos;s invoices with the workspace (their memos, purchase order references, amounts, what is still owed and due dates), the pay links
          of its open invoices, and what the customer and the workspace wrote about them, a member&apos;s reply shown under the workspace&apos;s name. It
          never shows another customer, the workspace&apos;s other records or ledger, or the names and emails of its members. Anyone with the link can
          also write to the workspace as that customer. What the customer writes is kept with the workspace&apos;s invoices; its signed ledger entry
          keeps the days, the amount and a SHA-256 fingerprint of the words, never the words.
        </p>
        <p>
          An owner or admin can send a vendor a link to its own payment status. Anyone with the link sees, until it
          expires or is stopped, that supplier&apos;s bills with the workspace (their memos, purchase order references, amounts, due dates and where
          each one stands: received, being reviewed, the day it is set to be paid, on its way, or paid), and for each payment made on Arc, its
          transaction on the public explorer. It never says why a bill is held, and never shows a rejected bill, another counterparty, the
          workspace&apos;s records, reasoning or ledger, or the names and emails of its members. In shadow mode it shows no bills. The page is read
          only: nothing is sent through it.
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
          Each workspace pays on one network, Arc mainnet or Arc testnet, chosen when it is created. Payments are USDC transfers on that network, and on Arc
          testnet EURC too, sent through Circle Developer-Controlled Wallets. A workspace that connects its own Circle account keeps its wallets in that account.
          A workspace on Arc testnet that chooses hosted wallets has them created in Vestiarion&apos;s own Circle testnet account, so Vestiarion holds them;
          you fund them from Circle&apos;s faucet.
        </p>
        <p>
          On Arc mainnet, an owner can make a wallet they hold the workspace&apos;s treasury instead: a wallet in their browser, such as MetaMask, or a passkey
          wallet. Vestiarion holds no key to it. It keeps the wallet&apos;s address and whether a passkey signs for it, the spending limit contract the wallet
          deployed, and the transactions that set it up and changed it. To make a browser wallet the treasury, the owner signs a message that names the
          workspace, Arc mainnet and the wallet&apos;s address, and the signed ledger keeps the message and the signature. For a passkey wallet, Vestiarion
          keeps the recovery address registered for it, or when the owner chose to go without one. The twelve words of a recovery phrase are made in the
          browser and never sent to Vestiarion. The agent&apos;s own wallet, which pays through the contract and holds only its gas, is created in
          Vestiarion&apos;s Circle account.
        </p>
        <p>
          While you set up or change such a treasury, your browser keeps, for the workspace, each transaction it sent, by its hash, until Vestiarion records
          it, so a reload does not send it twice; and for a passkey wallet, the public part of its passkey (its credential id and public key).
        </p>
        <p>
          When you bring USDC from another chain, your browser wallet burns it there through Circle&apos;s CCTP, and Circle&apos;s Forwarding Service mints it on
          Arc to the workspace&apos;s wallet. Vestiarion&apos;s server takes no part: your browser keeps the chain, the amount, the burn&apos;s hash and when it
          was sent until the USDC arrives, and asks Circle about that hash.
        </p>
        <p>
          Payee history: anyone who pays for it over x402 can ask, for one Arc address, how many workspaces here have paid it with live payments, how many such
          payments were confirmed, and when the first and the last were made. The answer names no workspace and no amount. On Arc testnet, a workspace&apos;s agent can
          buy the same answer before its first payment to an address, from a service budget a person gives it.
        </p>
      </LegalSection>

      <LegalSection id="services" title="Services that receive data">
        <ul>
          <li>
            <strong>Vercel</strong> hosts the app.
          </li>
          <li>
            <strong>Supabase</strong> holds the database and runs sign-in, and keeps the documents vendors send through a request&apos;s link in private
            storage.
          </li>
          <li>
            <strong>Circle</strong> creates the wallets and moves the payments, through Developer-Controlled Wallets, CCTP, Gateway and its Smart Contract Platform, so it receives wallet addresses and payment amounts. Its Stablecoin Service quotes EURC in USDC and builds the swaps of USDC for EURC, so it receives the operating wallet&apos;s address and the amounts. Gateway also verifies and settles the x402 payments for payee history, so it receives each signed payment: the paying wallet, the payee and the amount.
            For a payee who creates a wallet with a passkey on a payee link, Circle&apos;s Modular Wallets receive the passkey&apos;s public key, its
            credential id and the name it is saved under, and later the wallet&apos;s transfers, whose gas Circle&apos;s Gas Station pays. The passkey&apos;s
            private key stays on the payee&apos;s device or in their password manager and is never sent anywhere. Vestiarion keeps nothing of it.
            For an owner who makes a passkey wallet the treasury of a workspace on Arc mainnet, Modular Wallets receive the same of that passkey, the
            recovery address registered for the wallet, and the wallet&apos;s setup and later changes, whose network fees come from the wallet&apos;s own
            USDC. That passkey&apos;s private key stays on the owner&apos;s device or in their password manager too.
          </li>
          <li>
            <strong>Resend</strong> sends transactional email: invitations to a workspace, digests of the payments waiting for a decision, the link a payee
            adds their address through, payment notices to a payee once a live workspace&apos;s payment to them is confirmed, the reminders an owner
            or admin turns on for a client&apos;s invoice, with its pay link, the early-payment offers the agent makes to a supplier once an owner or admin turns them
            on, with the offer&apos;s one-time link, and its answer when the supplier proposes a smaller discount, the discounts for paying early the agent offers a
            customer while bills are held for cash, once an owner or admin turns them on, with the offer&apos;s one-time link, the requests for more time the agent sends a
            supplier once an owner or admin turns them on, with the request&apos;s one-time link, and a note to a workspace&apos;s owners and admins when a customer writes
            on its statement link, with at most 140 characters of what it wrote and no link it wrote, the question to a payee&apos;s billing email, when its payment address
            changes to a new one in a live workspace, whether they made the change, with a one-time link to answer, and a note to the owners and admins
            when the payee answers that they did not, the request to a vendor&apos;s billing email for a bill&apos;s missing purchase order or goods
            receipt, once an owner turns it on, with a one-time link (in a sandbox, to the member who turned it on instead), and a note to the
            owners and admins when the vendor sends it, which says whether they typed a purchase order number but not what they typed. It receives each
            recipient&apos;s email address and the message. When the
            team has turned it on, it also sends the team a short note about each new guided setup request, described below.
          </li>
          <li>
            <strong>A model provider</strong>, when this deployment has one configured (Anthropic, OpenAI or DeepSeek), receives the context of each decision
            the agent asks it about, and nothing else:
            <ul>
              <li>
                for an invoice: its amount and currency, its value in USDC for an invoice in EURC, memo, purchase order reference, due date, early-payment discount, late fee and
                whether the goods were received, and, for one a recurring payment created, its period and how often it repeats; the counterparty&apos;s name, risk level, payment limit, whether it needs a purchase order and performance score, and, when the agent bought it before a first payment, how many workspaces here have paid its address, how often, and when first and last; the operating balance and the reserve
                balance, or for an invoice in EURC the wallet&apos;s EURC balance, its USDC balance and the USDC due within 7 days, and, when its EURC falls short,
                the swap of USDC for EURC that could fund it (the USDC it takes, the EURC it gives at least and as estimated, and what it costs above the
                quoted rate), or why there is none; how the payee is paid, on Arc or across chains through CCTP or a Gateway balance with its fee
                and expected time; the payment timing worked out from those:
                today&apos;s date and the due date, what the discount is worth and the last day it applies, the yield from keeping the cash to the due date,
                the day the written policy would pay on and the amount due that day, the total and number of payments that fall due on or before that day,
                and whether the cash available by that day falls short of covering this invoice after them; when the agent scheduled the invoice earlier, the date it
                chose and its reasoning, and whether it is decided again before that date because the cash will not cover it then; and any earlier invoices from the same
                counterparty that look like duplicates of it, each with its amount, due date and status, the signals that matched, how strong the match is
                and what the match found;
              </li>
              <li>
                for a contractor milestone: its title, amount and verification source, how it was verified (whether, by what method, and the verifier&apos;s note), and the contractor&apos;s name, risk level, payment limit and
                performance score, and, when the agent bought it before a first payment, how many workspaces here have paid its address, how often, and when first and last;
              </li>
              <li>
                for an invoice document a member chooses to read (a PDF, an email or pasted text), and for each email that reaches a workspace&apos;s
                invoice address, its first PDF, .eml or .txt attachment, or else its text: the document&apos;s text, up to 20,000 characters, to read
                its vendor, amounts, dates, terms and payment address into the invoice form. Nothing is sent for an email that is too large, holds
                only images, or comes while the workspace is over its rate of documents read. The document itself is not kept;
              </li>
              <li>
                for a message a member sends the Telegram bot in plain words: the message, up to 4,000 characters, to tell which of the bot&apos;s questions it
                asks. The answer is read from the workspace and written by the app, not by the model;
              </li>
              <li>
                when the cash cannot cover every bill due within 14 days, to choose which are paid first: each such bill&apos;s payee name, amount, due date
                and days left, whether it is a recurring payment and how often, its memo and purchase order, an early-payment discount it would lose, a late fee and the day it starts, its
                status, and how many requests for more time its supplier was sent and how each ended (agreed, declined by the supplier, fewer days the
                agent declined, withdrawn by the agent, still open); the cash the agent can pay with, what is
                already committed, and the written policy&apos;s order. Code pays the bills in the order chosen only while the cash lasts;
              </li>
              <li>
                for a reminder to a client: the receivable&apos;s amount and currency, its due date and how far today is from it, what it is for (its memo
                and purchase order), the client&apos;s name and how it paid its earlier receivables (on time, late, and how late on average), the
                reminders already sent (when, and how firmly), the tones allowed, and the written policy&apos;s answer. The email itself is a fixed
                text; nothing the model writes is sent to the client;
              </li>
              <li>
                for a proposed payment limit: the counterparty&apos;s name, limit, risk level and performance score, and each payment people approved above
                that limit in the last 30 days (its amount, when, and what the agent had done with it), with how many were rejected;
              </li>
              <li>
                for a treasury move: the operating and reserve balances, the reserve&apos;s yield, the obligations due in the next 7 and 14 days, the total open
                obligations and the days until the next one is due, and the sweep&apos;s economics worked out from those: the cash above the required buffer, how
                long it could stay swept, the projected yield and the cost of the transfers; the most a sweep may take, and the most and least a redemption
                may bring back; for 24 hours after a person brings cash back from the reserve, until when nothing is swept; and, for a real USYC reserve,
                that it is real and whether USYC can be bought now.
              </li>
            </ul>
            A performance score comes with the counts it is computed from: payments paid without intervention, information requests, holds and flags,
            duplicate submissions, risk tier changes, and the holds the workspace&apos;s own limits caused. Without a model provider, a written rule-based policy
            decides, and nothing is sent. Each provider handles these requests under its own API terms:{" "}
            {MODEL_PROVIDER_TERMS.map((provider, index) => (
              <span key={provider.name}>
                {index > 0 ? (index === MODEL_PROVIDER_TERMS.length - 1 ? " and " : ", ") : ""}
                <LegalLink href={provider.href}>{provider.name}</LegalLink>
              </span>
            ))}
            . Someone running their own copy of Vestiarion can point <code>ANTHROPIC_BASE_URL</code>, which Anthropic&apos;s SDK reads, at another
            Anthropic-compatible host, and <code>OPENAI_BASE_URL</code> or <code>DEEPSEEK_BASE_URL</code> at another OpenAI-compatible one.
          </li>
          <li>
            <strong>Telegram</strong>, for a member who connects their own Telegram chat to a workspace, receives what the bot sends that chat: the
            workspace&apos;s name, the agent&apos;s decisions with the counterparties&apos; names, the amounts, the reasons and links to the transactions and to
            the app, and the answers to the member&apos;s questions. It receives no email address or key, and no wallet address in full: one named in a reason or a warning is shortened to its first and last four characters. An invoice the member sends the bot
            reaches Telegram from the member, and the app reads it the way it reads one uploaded to the invoice form, without keeping it.
          </li>
          <li>
            <strong>Slack</strong>, for a workspace an owner or admin connects to a Slack channel, receives what the app posts to that channel and its
            answers to members: the workspace&apos;s name, the agent&apos;s decisions with the counterparties&apos; names, the amounts, the reasons and links
            to the transactions and to the app, who decided a payment from Slack, and the answers to a member&apos;s questions. When a workspace
            with invoices by email gets an email at its invoice address that cannot be read, or in which no vendor is found, the post names the
            sender&apos;s email address; Slack receives no other email address, no key, and no wallet address in full: one is shortened to its first
            and last four characters. The app reads no message in Slack
            but one an owner or admin chooses to add as an invoice, read the way one uploaded to the invoice form is, without keeping it.
            It keeps the Slack workspace&apos;s and the channel&apos;s ids and names, the app&apos;s token and the channel&apos;s posting address,
            encrypted, and the Slack user id of each member who connects their own account; disconnecting Slack deletes them, and the signed ledger
            keeps only the ids. A Slack username given to connect an account is kept until that request is used or expires, and cleared when the next one is made.
          </li>
          <li>
            <strong>Discord</strong>, for a workspace an owner or admin connects to a Discord channel with its webhook, receives what Vestiarion
            posts to that channel: the workspace&apos;s name and, for each bill the agent holds or flags for a person, the counterparty&apos;s name,
            the amount, the agent&apos;s reason and a link to review it in the app. It receives no email address or key, and no wallet address in
            full: one is shortened to its first and last four characters. The app reads no message in Discord: when Discord is connected, it asks
            Discord only for the webhook&apos;s own details, its name and its channel&apos;s and server&apos;s ids. It keeps the webhook&apos;s id and
            name, the channel&apos;s and the server&apos;s ids, and the webhook&apos;s URL, encrypted; disconnecting Discord deletes them, and the
            signed ledger keeps only the ids.
          </li>
          <li>
            <strong>Resend</strong>, for a workspace that turns on invoices by email, receives the emails sent to its invoice address, as it
            receives every email at that domain. The app reads each one the way it reads an invoice uploaded to the invoice form and keeps the
            sender, the subject and what was read, with SPF, DKIM and DMARC as Resend reported them, until a person adds or dismisses it. The
            document itself is not kept, only its hash; the ledger keeps the sender&apos;s address with most of its name hidden.
          </li>
          <li>
            <strong>ExchangeRate-API</strong> gives the day&apos;s rates against the US dollar, for a bill typed in another currency in shadow
            mode. Vestiarion asks it only for the dollar&apos;s rates: it receives nothing about you, your workspace or your bills.
          </li>
          <li>
            <strong>OpenSanctions</strong>, when this deployment has it configured, receives the names and jurisdictions of a live workspace&apos;s
            counterparties to screen them. A sandbox, and any workspace on a deployment without it, checks names against a list built into the app and sends
            them nowhere. When our team checks that the service answers, it sends one made-up company name, nothing about any workspace.
          </li>
          <li>
            <strong>RPC nodes</strong> receive the wallet addresses and transaction hashes whose balances, fees and receipts Vestiarion&apos;s server
            reads: Arc&apos;s node, {ARC_RPC_HOSTS.join(" and ")}, and, where this deployment sets them, the ones named by <code>ARC_RPC_URL</code> and{" "}
            <code>ARC_MAINNET_RPC_URL</code>, which take some of those reads; receipts are always read from Arc&apos;s public node; and, for a receipt of a payout to another chain from Arc,{" "}
            {listed(PAYEE_CHAIN_RPC_HOSTS)}, PublicNode&apos;s among them. These are already public on chain, and nothing else about you or your workspace goes
            with them. To look up an ENS name or a Basename typed into an address field, or the ENS name of an address typed there, the server asks
            Ethereum&apos;s node at {ENS_RPC_HOST}, or the one <code>ENS_RPC_URL</code> names, and, for a Basename, Coinbase&apos;s gateway at{" "}
            {ENS_GATEWAY_HOSTS.join(" and ")}, which receive that name or address only. The other chains&apos; nodes named for bringing USDC from
            another chain are handed to your own wallet in your browser; the server never calls them.
          </li>
          <li>
            <strong>GitHub</strong> is asked for a pull request&apos;s status when a milestone is verified by its link, and, when a page shows a pull
            request or a comment on github.com given as evidence, whether it can still be opened: only its owner, repository and number go to
            GitHub&apos;s API, with the workspace&apos;s own GitHub connection or Vestiarion&apos;s, never your sign-in. For a workspace an owner or
            admin connects to GitHub, it also receives a comment on the pull request a milestone was paid for: the amount, the network, the
            workspace&apos;s name and the transaction&apos;s link, never the payee&apos;s name. The app keeps the installation&apos;s id, its
            account&apos;s login and type, and whether it covers all repositories or selected ones; disconnecting GitHub deletes them, and the
            signed ledger keeps only the ids and the login. The token of the person connecting, used once to check they can reach the installation,
            is not kept. GitHub also sends the app the comments on pull requests in those repositories. Only a comment with a line starting
            /bounty or /payto is acted on, and the rest are not kept. For each bounty, the app keeps the pull request, the logins of its author and
            of the person who attached it, the amount and the comment&apos;s link, and asks GitHub whether that person can write to the repository.
          </li>
          <li>
            <strong>Xero</strong>, for a workspace an owner or admin connects to a Xero organisation after agreeing to it, is read from, and written
            to only to book a payment an owner or admin approved: for each payment made on Arc for a bill brought in from Xero, Vestiarion sends Xero
            the bill&apos;s id, the account&apos;s id, the day, the amount and the Arc transaction, and reads the payment back. It also reads whether the
            organisation is a demo company, since payments on Arc testnet and in shadow mode are booked only into one. Vestiarion reads that
            organisation&apos;s approved bills (the supplier, the bill&apos;s number and reference, its currency, total,
            amount due, dates and status) and its suppliers&apos; names, and its chart of accounts when an owner or admin chooses the account payments
            will be booked to. It keeps the bills read, the suppliers&apos; names, the organisation&apos;s name and id, the access granted and the
            agreement given, and Xero&apos;s tokens encrypted, readable only by the server and never shown in the browser, a log, a model&apos;s prompt
            or a webhook. A bill reaches the agent, and so its model provider, only once a person added it as a payable, with the facts any bill
            has. Vestiarion never uses Xero data to train or improve any AI model, and never passes it to anyone else
            without the workspace&apos;s say. Disconnecting revokes the app&apos;s access at Xero and deletes the tokens; the bills already read stay with
            the workspace, and the signed ledger keeps only ids and names.
          </li>
          <li>
            <strong>QuickBooks Online</strong> (Intuit), for a workspace an owner or admin connects to a QuickBooks company after agreeing to it, is
            read from and never written to. Vestiarion reads that company&apos;s open bills (the vendor, the bill&apos;s number and memo, its currency,
            total, balance, dates and status), its vendors&apos; names, and its bank accounts when an owner or admin chooses the account payments will be
            booked to. It keeps the bills read, the vendors&apos; names, the company&apos;s name and id, the access granted and the agreement given, and
            the tokens encrypted, readable only by the server and never shown in the browser, a log, a model&apos;s prompt or a webhook. Intuit tells
            Vestiarion when a bill, a bill payment or a vendor changes, naming only the company and the record; Vestiarion reads the record itself and
            keeps nothing of the notice. A bill reaches the agent, and so its model provider, only once a person added it as a payable, with the facts
            any bill has. Vestiarion never uses QuickBooks data to train or improve any AI model, and never passes
            it to anyone else without the workspace&apos;s say. Disconnecting revokes the app&apos;s access at Intuit and deletes the tokens; the bills
            already read stay with the workspace, and the signed ledger keeps only ids and names.
          </li>
          <li>
            <strong>Zoho Books and Zoho CRM</strong> (Zoho). Zoho Books, for a workspace an owner or admin connects to a Zoho Books organization after
            agreeing to it, is read from and never written to; the access Zoho grants is read only. Vestiarion reads the names of the organizations the person connecting can
            reach, so they pick one, and keeps them only until they do, ten minutes at most. Of the organization picked, it reads the bills (the
            vendor, the bill&apos;s number and reference, its currency, total, balance, dates and status) and its vendors&apos; names. It keeps the open
            bills brought in for review, the vendors&apos; names, the organization&apos;s name and id, the Zoho data center the account lives in, the access granted and the
            agreement given, and the tokens encrypted, readable only by the server and never shown in the browser, a log, a model&apos;s prompt or a
            webhook. Every request goes to that data center&apos;s Zoho servers and no other. A bill reaches the agent, and so its model provider,
            only once a person added it as a payable, with the facts any bill has. Vestiarion never uses Zoho Books data to train or improve any AI
            model, and never passes it to anyone else without the workspace&apos;s say. Disconnecting revokes the app&apos;s access at Zoho and
            deletes the tokens; the bills already read stay with the workspace, and the signed ledger keeps only ids and names. Zoho CRM, for a
            workspace an owner or admin connects to a Zoho CRM organization after agreeing to it, is read from and never written to; the access Zoho
            grants is read only. Vestiarion reads that organization&apos;s deals, every one when it is connected and then those that change (each
            one&apos;s name, amount, currency, closing date, pipeline, stage, account and contact), each deal&apos;s account (its name) and
            contact (their email), the stages of its deal pipelines, and the organization&apos;s id, name and home currency; it sees only the deals
            the Zoho CRM user who connected can see. It keeps the open deals and those won from 90 days before it was connected, the accounts&apos;
            names, the contacts&apos; emails, the organization&apos;s id and name, the Zoho data center the account lives in, the access granted and
            the agreement given, and the tokens encrypted, readable only by the server and never shown in the browser, a log, a model&apos;s prompt
            or a webhook. Every request goes to that data center&apos;s Zoho servers and no other. A contact&apos;s email becomes a customer&apos;s
            billing email only when someone in the workspace confirms it. The deals are shown to the workspace&apos;s members and its agent; the
            agent&apos;s model provider may see a deal&apos;s facts to decide on its collections. Vestiarion never uses Zoho CRM data to train or
            improve any AI model, and never passes it to anyone else without the workspace&apos;s say. Several workspaces may connect the same
            organization. Disconnecting revokes the app&apos;s access at Zoho and deletes the tokens; the deals already read stay with the
            workspace, and the signed ledger keeps only ids, names, amounts and masked emails.
          </li>
          <li>
            <strong>BlindPay</strong>, for a workspace an owner sets up for bank payouts after accepting BlindPay&apos;s terms on BlindPay&apos;s own
            page, pays a vendor&apos;s bills to its bank account in Mexico over SPEI. It receives the workspace&apos;s name and the owner&apos;s email,
            for the business it pays from (in this version with BlindPay&apos;s test business values, on its development instance), each vendor&apos;s
            CLABE and the name its account is held in, the amount of each payout, and the operating wallet&apos;s address on Arc. Vestiarion keeps
            BlindPay&apos;s ids, the business&apos;s review status, and each account&apos;s bank and last four digits and the name it is held in; never
            the whole CLABE. The signed ledger keeps only ids, the bank&apos;s code and the last four digits. BlindPay never receives the
            workspace&apos;s bills, its other counterparties or the agent&apos;s reasoning.
          </li>
          <li>
            <strong>HubSpot</strong>, for a workspace an owner or admin connects to a HubSpot account after agreeing to it, is read from, and written
            to only once an owner or admin allows it: then each HubSpot deal planned in Vestiarion receives what was collected on it from payments
            confirmed on Arc, what is still owed, the last receipt&apos;s day, amount and transaction link, the reconciliation status and a link to the
            deal in Vestiarion, and nothing else. Vestiarion reads that account&apos;s open deals and the deals won in the last 90 days, then the deals that change (each
            one&apos;s name, amount, currency, close date, pipeline and stage), each deal&apos;s company (its name) and that company&apos;s main
            contact (its email), and the account&apos;s currency, time zone and domain. It keeps the deals read, the companies&apos; names, the main
            contacts&apos; emails, the account&apos;s id and domain, the access granted and the agreement given, and HubSpot&apos;s tokens encrypted,
            readable only by the server and never shown in the browser, a log, a model&apos;s prompt or a webhook. A contact&apos;s email becomes a
            customer&apos;s billing email only when a person confirms it. The deals are shown to the workspace&apos;s members and its agent; the
            agent&apos;s model provider may see a deal&apos;s facts to decide on its collections. Vestiarion never uses
            HubSpot data to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. Disconnecting revokes
            the app&apos;s access at HubSpot and deletes the tokens; the deals already read stay with the workspace, and the signed ledger keeps only
            ids, names, amounts and masked emails.
          </li>
          <li>
            <strong>Pipedrive</strong>, for a workspace an owner or admin connects to a Pipedrive company after agreeing to it, is read from, and
            written to only once an owner or admin allows it: then each Pipedrive deal planned in Vestiarion receives, in deal fields Vestiarion
            creates, what was collected on it from payments confirmed on Arc, what is still owed, the last receipt&apos;s day, amount and transaction
            link, the reconciliation status and a link to the deal in Vestiarion, and nothing else. Pipedrive does not say which of its companies are
            developer sandboxes, so only payments made on Arc mainnet outside shadow mode are written to it. Vestiarion reads that company&apos;s open deals and the deals won from 90 days before it was connected, then the deals
            that change (each one&apos;s title, value, currency, status, pipeline and stage, its won, lost or expected close date and its lost
            reason), each deal&apos;s organization (its name) and person (their primary email), and the company&apos;s id and name; it sees only the
            deals the Pipedrive user who connected can see. Pipedrive tells Vestiarion when a deal changes; Vestiarion does not read what the
            notice says, and reads the deals from Pipedrive itself. It keeps the deals read, the organizations&apos; names, the persons&apos;
            emails, the company&apos;s id and name, the access granted and the agreement given, and Pipedrive&apos;s tokens encrypted, readable
            only by the server and never shown in the browser, a log, a model&apos;s prompt or a webhook. A person&apos;s email becomes a
            customer&apos;s billing email only when someone in the workspace confirms it. The deals are shown to the workspace&apos;s members and its
            agent; the agent&apos;s model provider may see a deal&apos;s facts to decide on its collections. Vestiarion
            never uses Pipedrive data to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. One
            Pipedrive company connects to one workspace at a time. Disconnecting revokes Vestiarion&apos;s access, which, as Pipedrive documents it,
            uninstalls Vestiarion from the company, and deletes the tokens; the deals already read stay with the workspace, and the signed ledger keeps only ids, names, amounts and masked emails.
          </li>
          <li>
            <strong>Asana</strong>, for a workspace an owner or admin connects to their Asana after agreeing to it, is read from, as that person, and
            written to only to make and delete the webhooks on the tasks linked to milestones. Vestiarion reads the workspaces, projects and tasks a
            member opens to link a task, and for each linked task its name, whether and when it was completed and by whom (their name), its assignee
            (their name), its attachments (their names, upload times and links) and the links in its description and comments. It keeps the linked
            tasks&apos; names and links, the names of who completed and was assigned each one, the deliverables&apos; names and links and their
            fingerprint, the Asana user&apos;s id and name the connection acts as, the access granted and the agreement given, each webhook&apos;s
            secret and Asana&apos;s tokens encrypted, readable only by the server and never shown in the browser, a log, a model&apos;s prompt or a
            webhook; it does not keep the words of a task&apos;s description or comments. To refuse an acceptance by the payee, it asks Asana
            whether a member&apos;s email, or the email a contractor&apos;s payment notices go to, belongs to an Asana user, and keeps only the answer
            for that check. A webhook from Asana carries no task&apos;s facts that Vestiarion keeps: it only has the task read again. Vestiarion never
            uses Asana data to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. Disconnecting
            deletes the webhooks, revokes the app&apos;s access at Asana and deletes the tokens; the acceptances already recorded stay with the
            workspace&apos;s signed ledger.
          </li>
          <li>
            <strong>Google Analytics</strong> receives page views on every page, signed-in pages included, and which button you chose to get
            started, as described below.
          </li>
          <li>
            <strong>Product Hunt</strong> serves the badge in the footer of the home page, the page for studios and the page on how the agent decides, so your browser loads that image from Product Hunt, which sees your IP
            address and browser like any site an image comes from. Nothing else is sent to it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="analytics" title="Analytics">
        <p>When this deployment sets a measurement ID, Vestiarion counts page views with Google Analytics 4. Before a page view leaves your browser:</p>
        <ul>
          <li>
            an invitation address becomes <code>/invite/:token</code>, a payee link <code>/payee/:token</code>, a client&apos;s pay link{" "}
            <code>/pay/:token</code>, a receipt link <code>/receipt/:token</code>, a shared report <code>/report/:token</code>, a customer&apos;s statement{" "}
            <code>/statement/:token</code>, a supplier&apos;s payment status <code>/supplier/:token</code>, an early-payment offer <code>/offer/:token</code> a customer&apos;s discount <code>/discount/:token</code>, a request for more time{" "}
            <code>/more-time/:token</code>, a question about a payee&apos;s address change <code>/address-change/:token</code>, a request for a
            bill&apos;s missing document <code>/documents/:token</code> and an accountant&apos;s client link <code>/join/:token</code>, and a
            workspace address has the workspace&apos;s slug
            replaced, as <code>/o/:org</code>;
          </li>
          <li>only the path is sent, never the query string or anything after a #;</li>
          <li>the title of a workspace page, which names the workspace, is replaced with its redacted path;</li>
          <li>a referrer on this site is redacted the same way, and a referrer from another site is cut to its origin.</li>
        </ul>
        <p>
          When you choose a button that starts you off, such as <strong>Try it on your bills</strong>, it also counts that choice as an event named{" "}
          <code>cta_click</code>, with the button&apos;s name (such as <code>hero-try</code>) and the page&apos;s path, redacted the same way. Nothing you
          typed and nothing about you goes with it.
        </p>
        <p>
          It loads on every page, signed-in pages included. Google signals and ad personalization signals are turned off. Google Analytics sets its
          own cookies to tell visits apart, and collects what any site it runs on sends it, such as your IP address and your device and browser.
        </p>
      </LegalSection>

      <LegalSection id="campaign-cookie" title="Which link brought a workspace">
        <p>
          When you arrive from a link that carries campaign tags (<code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code>,{" "}
          <code>utm_content</code>, <code>utm_term</code> or <code>ref</code>), Vestiarion sets one first-party cookie, <code>vx_ft</code>, for 90 days. It is
          set only when a link carries such a tag and the browser does not hold one already, and setting it sends nothing anywhere.
        </p>
        <ul>
          <li>
            It holds those tags, each cut to 100 letters, digits, dots, hyphens, underscores and tildes, the page you landed on without its query, the
            host of the site that linked to it, and when.
          </li>
          <li>It never holds your email address, your name or anything you type; a tag with an @ in it is dropped.</li>
          <li>
            When you create a workspace, Vestiarion reads it once and keeps those tags with the workspace, never replaced, so the team can see which
            outreach or page brought it. Only the team sees them, and they are deleted with the workspace.
          </li>
          <li>
            A workspace opened from an accountant&apos;s client link keeps the tags <code>accountant</code>, <code>client_link</code> and{" "}
            <code>accountant_client</code> instead of the cookie&apos;s, unless the accountant could not be added: it then keeps the cookie&apos;s tags,
            as any new workspace does.
          </li>
          <li>When you ask for a guided setup, those tags are kept with your request too, as described below.</li>
          <li>
            The pages and emails a business sends its suppliers, payees and customers through Vestiarion (a payment status, an address link, a receipt,
            an offer, a request for more time, a pay link, a statement, a shared report) end with a link to Vestiarion&apos;s site. That link&apos;s tags
            name only the kind of page or email it is on, its medium and <code>counterparty_loop</code>: never the business, the person, the link or an
            amount.
          </li>
          <li>Deleting the cookie in your browser changes nothing else.</li>
        </ul>
      </LegalSection>

      <LegalSection id="guided-setup" title="Asking for a guided setup">
        <p>
          The form on the <LegalLink href="/studios">page for studios</LegalLink> asks for your name, your work email, your studio&apos;s name and,
          if you give it, its website, how many contractors you pay a month, how invoices reach you, and anything else you write, up to 500 characters.
        </p>
        <ul>
          <li>We use these details only to set up a call with you about Vestiarion.</li>
          <li>
            They are stored in Vestiarion&apos;s Supabase Postgres database as one entry in the team&apos;s own records, apart from every workspace, with
            the day you sent them and, when your browser holds the <code>vx_ft</code> cookie above, its campaign tags. Your IP address is not kept with them.
          </li>
          <li>
            Only the Vestiarion team sees them, in a dashboard nobody else can open. They are not shared with anyone else and not added to any marketing
            list, and nothing is sent to you automatically: a person on the team writes to you.
          </li>
          <li>
            When the team has turned it on, Resend emails the team your studio&apos;s name, how many contractors you pay and how invoices reach you,
            never your message.
          </li>
          <li>They are kept until the team deletes them. Ask through Contact, below, and we delete them.</li>
        </ul>
      </LegalSection>

      <LegalSection id="decision-reasons" title="Reasons you give for going against the agent">
        <p>
          When you disagree with the agent in shadow mode, reject a bill, return one to the agent, or pay a bill the agent flagged or held, the console
          asks why, in one line you may leave empty. Nothing waits on it.
        </p>
        <ul>
          <li>
            A reason you give is kept in the workspace&apos;s records in Vestiarion&apos;s Supabase Postgres database, up to 280 characters, with what you
            did and where (such as returning a bill to the agent, in the console), the bill it is about, your account&apos;s id, when, and the
            version of Vestiarion that asked. A reason for disagreeing, rejecting or returning is also kept with that decision in the workspace&apos;s signed
            ledger, as decisions always are.
          </li>
          <li>
            The workspace&apos;s owners and admins see the latest ones on Insights, without your name. The Vestiarion team sees the latest ones across
            workspaces, with the workspace&apos;s slug and never your name or email, in a dashboard nobody else can open, to decide what to improve in the
            agent. They are not shared with anyone else.
          </li>
          <li>They are kept until the workspace is deleted, and deleted with it.</li>
          <li>
            When you delete your account, the reasons in a workspace deleted with it go with that workspace. In a workspace that stays, a reason stays
            without your account&apos;s id; the ledger entry of the same decision keeps your account&apos;s id, as every ledger entry does.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="chrome-extension" title="The Chrome extension">
        <p>
          Vestiarion Invoice Capture is a Chrome extension that sends an invoice from your browser to a workspace as a draft, for a person to add as a
          bill. You connect it by signing in and allowing it on Vestiarion&apos;s own page; it never holds your password or an API key.
        </p>
        <ul>
          <li>
            It reads a page only when you press <strong>Capture selected text</strong>, or choose <strong>Capture invoice with Vestiarion</strong> on a
            selection, and then only the text you selected, at most 20,000 characters. A file is sent only when you choose it in the extension: a PDF, a
            text or email file, or a picture, of at most 4 MB. It never reads your browsing history or any other page. Text taken with Capture
            invoice with Vestiarion waits in the extension&apos;s memory until you send it or drop it, and is dropped after 5 minutes.
          </li>
          <li>
            What you capture goes only to Vestiarion, at www.vestiarion.xyz, which reads it the way it reads an invoice uploaded to the invoice form:
            its text goes to the model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service), under that provider&apos;s own{" "}
            <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>.
            A picture is not read.
          </li>
          <li>
            Vestiarion keeps the draft in the workspace&apos;s records: the fields read and as you edited them (supplier, invoice number, amount,
            currency, invoice date, due date, purchase order and memo), who captured it and when, and the file&apos;s kind and SHA-256. A file itself is
            never kept. The text it was read from is kept for the person who reviews the draft, and removed when the draft is added as a bill or
            discarded, and 30 days after capture at the latest. A draft never sent for review is deleted within 7 days.
          </li>
          <li>
            The workspace&apos;s members see a draft once it is sent for review, with the text it was read from. The extension sees only the drafts it
            created, and never the workspace&apos;s bills, counterparties, members, wallets or keys.
          </li>
          <li>
            The extension keeps its access token (an hour) in memory only, and its refresh token (30 days) in Chrome&apos;s storage for extensions
            on your computer. Vestiarion keeps only their SHA-256, with the workspace, your account&apos;s id and the extension&apos;s id. A connection
            lasts at most 90 days from connecting. <strong>Disconnect</strong>, in the extension or in Settings, ends it at once. If your role can no
            longer add bills, the connection&apos;s next request is refused and the connection ends then. Leaving the workspace deletes it. Vestiarion keeps a connection&apos;s row, without any usable token, for 30 days after
            it ended or expired, and each one-time sign-in code for a day after it expired.
          </li>
          <li>
            The extension has no analytics. Nothing about an invoice you capture is sent to an analytics service, by the extension or by Vestiarion.
          </li>
          <li>Deleting the workspace deletes its drafts with it.</li>
        </ul>
      </LegalSection>

      <LegalSection id="vendor-documents" title="A vendor's page for a missing document">
        <p>
          When an owner turns on vendor requests in Settings, and a bill waits for its purchase order or goods receipt, Vestiarion emails the bill&apos;s
          vendor at the billing email a member gave, with a one-time link where the vendor sends the document. In shadow, nothing is sent. A
          sandbox never emails its vendors: its requests go to the member who turned vendor requests on, who answers as the vendor would.
        </p>
        <ul>
          <li>
            The billing email is used once per request, to send it. The request and the ledger keep only the address&apos;s domain, never the
            address itself or the link.
          </li>
          <li>
            The page shows the workspace&apos;s name, the vendor&apos;s own invoice number, its amount and due date, and what is missing. It needs no
            account, and an expired, answered or revoked link shows one sentence and names no one.
          </li>
          <li>
            It collects one file, a PDF, PNG or JPEG of at most 10 MB, a purchase order number if the vendor types one, and a note of at most 500
            characters. The file goes from the vendor&apos;s browser straight to the workspace&apos;s private storage at Supabase. Vestiarion checks
            what kind of file it is from its first bytes, keeps it under its SHA-256 with its kind and size, and removes a file it does not take.
          </li>
          <li>
            The vendor&apos;s IP address limits how often the page can be sent. It is held in the server&apos;s memory for minutes, and never kept.
          </li>
          <li>
            The file is read by no model and shown on no Vestiarion page. Any member of the workspace opens it as a download, through an address that
            works for one minute. Nothing about it changes the bill: a person adds the details, and the agent decides the bill again.
          </li>
          <li>
            Deleting the workspace, by its owner, with its last member&apos;s account or as an idle sandbox, deletes its requests and the files
            vendors sent. Removing the sample data deletes those of its sample vendors.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="retention" title="How long data is kept">
        <ul>
          <li>
            A sandbox workspace with no activity for 60 days is deleted by a daily cleanup. A sandbox is kept if Circle credentials are connected to it, if
            it holds a hosted wallet, or if its owner&apos;s own wallet deployed its contract.
          </li>
          <li>A webhook delivery is deleted 30 days after it is delivered; one that failed, 30 days after it was created.</li>
          <li>
            Text captured with the Chrome extension is removed when its draft is added or discarded, and 30 days after capture at the latest; a
            draft never sent for review is deleted within 7 days. A Chrome extension connection is deleted 30 days after it ended or expired, and a
            one-time sign-in code a day after it expired.
          </li>
          <li>
            The outcome of an API write sent with an <code>Idempotency-Key</code>, its response included, is given back for 24 hours, and deleted
            by the daily cleanup after that.
          </li>
          <li>
            Everything else in a workspace is kept until the workspace is deleted, or until a person removes it: disconnecting a tool, removing
            sample data or turning a feature off deletes what it held.
          </li>
          <li>
            The Vestiarion team&apos;s own records of a business it is in touch with, its lead and any revenue recorded for it, are kept apart from
            every workspace and stay when that business&apos;s workspace is deleted: their link to the workspace is cleared, and the lead&apos;s
            history keeps the workspace&apos;s id.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="delete-workspace" title="Deleting a workspace">
        <p>
          An owner can delete a workspace from its Settings, typing its slug to confirm. A live workspace&apos;s agent has to be paused first, and deletion
          waits while a cycle is running or a payment is being made.
        </p>
        <p>
          Deletion removes the workspace&apos;s invoices, counterparties, milestones, treasury records, ledger, API keys, webhooks, members and invitations, in
          one step, for everyone in it, and cannot be undone. The documents vendors sent through its requests are then removed from its private storage. Vestiarion keeps a tombstone that only the platform can read: the workspace&apos;s slug and name,
          who deleted it and when, and its ledger&apos;s length, head hash and signing key id.
        </p>
        <p>
          The workspace&apos;s wallets stay in the Circle account that holds them, with any USDC in them. For hosted wallets, that is Vestiarion&apos;s testnet
          account. A treasury in an owner&apos;s own wallet on Arc mainnet stays theirs, and its approval for the contract stays as it was until that wallet
          changes it, so stop the agent&apos;s payments from it before deleting the workspace.
        </p>
      </LegalSection>

      <LegalSection id="delete-account" title="Deleting your account">
        <p>
          <strong>Delete account</strong> is under Danger zone, at the end of a workspace&apos;s Settings and of your account&apos;s own page, which <strong>Account settings</strong> in the account menu opens, with or without a workspace. It needs no workspace role. Its
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
          the invitations and client links you sent go with it, as do the payment approvals you gave, which the ledger keeps, and your Slack and Telegram links. API
          keys you created stop working, and stay, revoked, without your name. Records you added in workspaces you share stay, without your name on them.
          A workspace&apos;s signed ledger is append-only, so entries you caused keep your account&apos;s id (never your email). A workspace deleted with your
          account leaves its tombstone, and a tombstone keeps who deleted it, as your account&apos;s id.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions and requests go to <LegalLink href={ISSUES_URL}>GitHub Issues</LegalLink>. The <LegalLink href="/terms">Terms of use</LegalLink> cover
          using the service, and <LegalLink href="/security">Security</LegalLink> says how the data is protected and how to report a vulnerability.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
