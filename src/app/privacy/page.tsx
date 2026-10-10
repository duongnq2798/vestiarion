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
      updated="2026-10-10"
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
          <li>
            counterparties: their names, wallet addresses, screening results and payment limits, and their billing email when a member gives one, where
            payment notices and reminders go;
          </li>
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
            For a payee who creates a wallet with a passkey on a payee link, Circle&apos;s Modular Wallets receive the passkey&apos;s public key, its
            credential id and the name it is saved under, and later the wallet&apos;s transfers, whose gas Circle&apos;s Gas Station pays. The passkey&apos;s
            private key stays on the payee&apos;s device or in their password manager and is never sent anywhere. Vestiarion keeps nothing of it.
          </li>
          <li>
            <strong>Resend</strong> sends transactional email: invitations to a workspace, digests of the payments waiting for a decision, the link a payee
            adds their address through, payment notices to a payee once a live workspace&apos;s payment to them is confirmed, and the reminders an owner
            or admin turns on for a client&apos;s invoice, with its pay link. It receives each recipient&apos;s email address and the message. When the
            team has turned it on, it also sends the team a short note about each new guided setup request, described below.
          </li>
          <li>
            <strong>A model provider</strong>, when this deployment has one configured (Anthropic, OpenAI or DeepSeek), receives the context of each decision
            the agent asks it about, and nothing else:
            <ul>
              <li>
                for an invoice: its amount and currency, its value in USDC for an invoice in EURC, memo, purchase order reference, due date, early-payment discount and
                whether the goods were received, and, for one a recurring payment created, its period and how often it repeats; the counterparty&apos;s name, risk level, payment limit, whether it needs a purchase order and performance score, and, when the agent bought it before a first payment, how many workspaces here have paid its address, how often, and when first and last; the operating balance and the reserve
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
                for a message a member sends the Telegram bot in plain words: the message, up to 4,000 characters, to tell which of the bot&apos;s questions it
                asks. The answer is read from the workspace and written by the app, not by the model;
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
            decides, and nothing is sent.
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
            to the transactions and to the app, who decided a payment from Slack, and the answers to a member&apos;s questions. It receives no email
            address or key, and no wallet address in full: one is shortened to its first and last four characters. The app reads no message in Slack
            but one an owner or admin chooses to add as an invoice, read the way one uploaded to the invoice form is, without keeping it.
            It keeps the Slack workspace&apos;s and the channel&apos;s ids and names, the app&apos;s token and the channel&apos;s posting address,
            encrypted, and the Slack user id of each member who connects their own account; disconnecting Slack deletes them, and the signed ledger
            keeps only the ids. A Slack username given to connect an account is kept until that request is used or expires, and cleared when the next one is made.
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
            them nowhere.
          </li>
          <li>
            <strong>GitHub</strong> is asked for a pull request&apos;s status when a milestone is verified by its link. For a workspace an owner or
            admin connects to GitHub, it also receives a comment on the pull request a milestone was paid for: the amount, the network, the
            workspace&apos;s name and the transaction&apos;s link, never the payee&apos;s name. The app keeps the installation&apos;s id, its
            account&apos;s login and type, and whether it covers all repositories or selected ones; disconnecting GitHub deletes them, and the
            signed ledger keeps only the ids and the login. The token of the person connecting, used once to check they can reach the installation,
            is not kept. GitHub also sends the app the comments on pull requests in those repositories. Only a comment with a line starting
            /bounty or /payto is acted on, and the rest are not kept. For each bounty, the app keeps the pull request, the logins of its author and
            of the person who attached it, the amount and the comment&apos;s link, and asks GitHub whether that person can write to the repository.
          </li>
          <li>
            <strong>Google Analytics</strong> receives page views, as described below.
          </li>
          <li>
            <strong>Product Hunt</strong> serves the badge on the home page, so your browser loads that image from Product Hunt, which sees your IP
            address and browser like any site an image comes from. Nothing else is sent to it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="analytics" title="Analytics">
        <p>When this deployment sets a measurement ID, Vestiarion counts page views with Google Analytics 4. Before a page view leaves your browser:</p>
        <ul>
          <li>
            an invitation address becomes <code>/invite/:token</code>, a payee link <code>/payee/:token</code>, a client&apos;s pay link{" "}
            <code>/pay/:token</code> and a receipt link <code>/receipt/:token</code>, and a workspace address has the workspace&apos;s slug
            replaced, as <code>/o/:org</code>;
          </li>
          <li>only the path is sent, never the query string or anything after a #;</li>
          <li>the title of a workspace page, which names the workspace, is replaced with its redacted path;</li>
          <li>a referrer on this site is redacted the same way, and a referrer from another site is cut to its origin.</li>
        </ul>
        <p>Google signals and ad personalization signals are turned off. Google Analytics sets its own cookies to tell visits apart.</p>
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
          <li>When you ask for a guided setup, those tags are kept with your request too, as described below.</li>
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
          <strong>Delete account</strong> is the last item of the account menu, below Sign out: under your email address inside a workspace, and behind your initial at the top of the workspaces page. It needs no workspace role. Its
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
          the invitations you sent go with it. API keys you created stop working. Records you added in workspaces you share stay, without your name on them.
          A workspace&apos;s signed ledger is append-only, so entries you caused keep your account&apos;s id (never your email). A workspace deleted with your
          account leaves its tombstone, and a tombstone keeps who deleted it, as your account&apos;s id.
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
