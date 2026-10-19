import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { CI_URL, GITHUB_URL, SECURITY_ADVISORY_URL, SECURITY_POLICY_URL } from "@/lib/site-links";
import { MODEL_PROVIDER_TERMS, SUBPROCESSORS, SUBPROCESSORS_AS_OF } from "@/lib/subprocessors";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Vestiarion protects the data and money it handles: architecture, tenant isolation, encryption, access control, connector tokens, webhooks, the signed ledger, subprocessors, and how to report a vulnerability.",
  alternates: { canonical: "/security" },
};

/**
 * The security page, for marketplace and security reviewers. Static and public. Every statement is what the code does
 * today, and the last section says what is not claimed; `tests/security-page.test.tsx` reads the figures it quotes from
 * the code, and holds its subprocessors (`src/lib/subprocessors.ts`) to the privacy page's services.
 */
export default function SecurityPage() {
  return (
    <LegalPage
      eyebrow="Trust"
      title="Security"
      updated="2026-10-16"
      intro="How Vestiarion protects the data and the money it handles, for anyone reviewing the app, its API or its integrations. Every statement describes what the code does today, and the code is public, so each one can be checked against it. What we do not claim is at the end."
    >
      <LegalSection id="architecture" title="Architecture and data flow">
        <p>
          Vestiarion is one Next.js application, hosted on Vercel, with its data in a Supabase Postgres database. Data moves through it in five steps,
          and each step is a boundary:
        </p>
        <ul>
          <li>
            <strong>In.</strong> People use the app in their browser, signed in through Supabase Auth with an emailed link or Google, never a password.
            Programs use the REST API, the SDK, the CLI or the MCP server with a workspace API key. Connected tools are read with the grant a workspace
            gave them, and tell Vestiarion about changes with webhooks it verifies. Scheduled jobs call their routes with the deployment&apos;s own
            token. The Chrome extension Vestiarion Invoice Capture uses a token of its own, issued when a member allows it and good for at most 90
            days, that can only create and read the drafts it captured. A request is checked by its session, its key, its signature, its token or
            the token of a shared link, and a person&apos;s role decides what they may do.
          </li>
          <li>
            <strong>Stored.</strong> A workspace&apos;s records are rows in Postgres, kept apart from other workspaces&apos; as{" "}
            <a href="#isolation">Tenant isolation</a> describes. Secrets are encrypted before they are stored.
          </li>
          <li>
            <strong>Decided.</strong> When this deployment has a model provider, the agent sends it the facts of one decision and gets back a proposal,
            which must match a fixed schema. A proposal is not a payment: rules in code check it, and people decide what the rules hold for them. Without
            a provider, a written rule-based policy proposes, and nothing is sent.
          </li>
          <li>
            <strong>Paid.</strong> Payments are transfers on Arc, sent through Circle&apos;s Developer-Controlled Wallets. On Arc mainnet, a treasury in
            the owner&apos;s own wallet pays only through a spending limit contract that wallet deployed.
          </li>
          <li>
            <strong>Recorded.</strong> Every decision, refusal, approval and payment is appended to the workspace&apos;s ledger, signed and chained by
            hash, and sent, signed, to the webhook endpoints the workspace set up.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="isolation" title="Tenant isolation">
        <p>
          No request for one workspace reads or changes another workspace&apos;s records. These answers cross workspaces, and name none:
        </p>
        <ul>
          <li>
            the <LegalLink href="/open">open numbers</LegalLink>: counts and USDC totals across workspaces, such as the USDC paid and the USDC held in
            wallets, for customers and for the team apart, so on a network with one customer its total is that customer&apos;s; and the team&apos;s
            own workspaces&apos; payments, up to the latest 20 with their amounts and transactions, and their USDC by day;
          </li>
          <li>
            the latest decisions on the home page and the page for studios, the team&apos;s own workspaces&apos; only, with their amounts and
            transactions;
          </li>
          <li>whether any live workspace runs a real USYC reserve, a yes or a no;</li>
          <li>
            payee history, sold over x402, which says for one address how many workspaces paid it, how many such payments were confirmed, and when
            the first and the last were made, with no amount.
          </li>
        </ul>
        <p>Only the team&apos;s own workspaces&apos; payments are ever listed, with amounts; a customer&apos;s are counted in totals and never listed.</p>
        <ul>
          <li>
            <strong>In the server.</strong> Workspace tables are reached through <code>db()</code>, which adds the workspace to every query and every
            insert and refuses a row that names another workspace. The service-role client, <code>platformDb()</code>, reaches only an allowlist of
            platform tables and functions, such as memberships, API keys, webhook endpoints and connector tokens, many of which hold rows for every
            workspace. Code that uses it, in about 70 files, names the workspace in its queries itself, except where it looks a row up by a token or
            a key prefix, or runs a job across workspaces, such as webhook delivery and the daily cleanup. A lint rule forbids importing the raw
            database client anywhere in <code>src</code> outside the data access layer and the module that makes it.
          </li>
          <li>
            <strong>In the database.</strong> Each request through <code>db()</code> runs as a dedicated Postgres role, with a token the server signs
            for that request alone: it names the workspace and the person, or <code>system</code> for scheduled jobs, scripts, and requests made with
            an API key, through the MCP server or by a webhook, and expires after 5 minutes. <code>db()</code> never falls back to the service role. Every workspace table that role can reach has row-level security with a
            restrictive policy that holds it to the token&apos;s workspace, whatever other policy is added later. A few database functions run only as
            the service role and write workspace rows after their own checks, such as pausing the agent, a customer&apos;s message on a
            statement link, turning on the USYC reserve and deleting a workspace.
          </li>
        </ul>
        <p>
          The roles a browser session or an anonymous visitor carries hold no privileges on the tables at all, and the platform&apos;s own tables grant
          the workspace role nothing. Most links between workspace records carry the workspace in their foreign key, so the database refuses a link into
          another workspace&apos;s row. Exceptions: a EURC swap&apos;s link to its invoice, and a webhook delivery&apos;s links to its endpoint and
          its ledger entry, carry no workspace; and a column that may point at more than one kind of record, such as the payment an approval is
          for, has no foreign key at all. The swap stays under row-level security, and webhook deliveries are a platform table the workspace role
          cannot reach.
        </p>
      </LegalSection>

      <LegalSection id="encryption" title="Encryption">
        <p>
          The app and its API are served over HTTPS. Secrets are encrypted in the app before they reach the database, with AES-256-GCM and a fresh
          96-bit IV for each one, under a master key the deployment holds as a secret. Each ciphertext is bound to its workspace and its field, and
          OAuth tokens and webhook secrets to their row too, so a copy moved into another workspace or field does not decrypt. Encrypted this way:
        </p>
        <ul>
          <li>the Circle API key and entity secret a workspace connects;</li>
          <li>each workspace&apos;s Ed25519 ledger signing key;</li>
          <li>each webhook endpoint&apos;s signing secret, and the secret of each webhook Asana sends;</li>
          <li>the OAuth access and refresh tokens of Xero, QuickBooks Online, Zoho Books, HubSpot, Pipedrive, Zoho CRM and Asana;</li>
          <li>a Slack connection&apos;s bot token and posting address, bound to the workspace and the field;</li>
          <li>
            a client pay link&apos;s token, so the link can be shown again on its card and the customer&apos;s statement page and sent in
            reminders; it is also hashed, and looked up by the hash.
          </li>
        </ul>
        <p>
          Each envelope names the master key that sealed it. The first key listed encrypts and any listed key decrypts, so a new master key can be
          added without breaking what an older one sealed.
        </p>
        <p>
          Some secrets are kept only as a SHA-256 hash: an API key&apos;s 256-bit secret, beside its prefix, compared in constant time; the tokens of
          invitations, payee links, customer statement links, suppliers&apos; payment status links, early-payment offers, customers&apos; discount offers, and shared receipts and reports; the codes that link a Telegram chat or a Slack
          account; and the Chrome extension&apos;s access and refresh tokens and its one-time sign-in codes. Some are never stored: the GitHub token of the person connecting GitHub is used once and dropped, a GitHub App installation&apos;s
          tokens are made for each run and kept in memory, and the password Pipedrive sends with its webhooks is derived from the master key for each
          company.
        </p>
      </LegalSection>

      <LegalSection id="access" title="Access control">
        <p>
          Every member of a workspace has one role: <strong>owner</strong>, <strong>admin</strong>, <strong>approver</strong>,{" "}
          <strong>accountant</strong> or <strong>viewer</strong>. <LegalLink href="/privacy#roles">Privacy</LegalLink> says what each can see and do.
          The rules that decide whether money moves:
        </p>
        <ul>
          <li>
            <strong>Maker and checker.</strong> Owners and admins add records. Owners, admins and approvers decide the payments the agent held, pause
            the agent, and can mark a screening match as not the counterparty. An accountant books payments, applies money received and answers
            customers, but decides no payment. A viewer reads, and changes only their own settings and links.
          </li>
          <li>
            <strong>No self-approval.</strong> The database&apos;s approval function refuses the person who created an invoice unless they are the
            workspace&apos;s only owner, admin or approver, or another approver&apos;s unused approval of the same amount already stands. The app
            narrows that further: being the only approver counts only at or below the two-approvals figure, and above it the creator may give one of
            the two approvals only when at most one person who neither entered it nor gave its address can approve, never both. The ledger entry says when either applied. A partner named
            on a commission plan never approves the payable that pays them.
          </li>
          <li>
            <strong>A first payment to a new address.</strong> Where payments are real, the agent never makes the first payment to a payee at an
            address that only the person who gave it stands behind, even when the workspace has paid that address for someone else, and that
            person cannot approve it, unless they are the workspace&apos;s only owner, admin or approver; the ledger entry says so. For an address a
            payee sends through a payee link, the person who created the link counts as having given it, read from the link&apos;s signed entry in
            the workspace&apos;s ledger, or from the link&apos;s own record when that entry is missing: their own confirmation is not the second person.
            A GitHub account is tied to no member, so for an address sent with /payto on a GitHub pull request, and for one no member can be
            named as having given, no confirmation counts as the second person: the agent holds the first payment, and two different members
            stand behind it, one who confirms the address and another who approves the payment. Whoever confirmed it cannot approve it, and no
            one approves it alone before another member has confirmed it, since an approval&apos;s own confirmation does not count, unless they are the
            workspace&apos;s only owner, admin or approver.
            A bounty typed by its own pull request&apos;s author names no member.
          </li>
          <li>
            <strong>Two approvals.</strong> Above a figure the owner sets, a payment needs two different people, and one person cannot give both. A
            workspace with a single approver cannot pay above the figure until it is raised or another approver joins. On Arc mainnet a workspace
            starts with two approvals above 100 USDC, and the figure can be raised or lowered but not turned off.
          </li>
          <li>
            <strong>Rules in code the model cannot override.</strong> After the model has answered, every bill the agent would pay passes the checks
            in <code>src/lib/agent/guardrails.ts</code>. They hold or refuse a payment to a counterparty screened high risk, one not screened yet, one
            without a payment address or with an address no one confirmed, a duplicate of a bill already paid, a bill missing its purchase order or
            goods receipt, a payment above the counterparty&apos;s limit, above the two-approvals figure or past the agent&apos;s spending limit. A
            contractor&apos;s milestone passes checks of its own, written into the cycle in <code>src/lib/agent/orchestrator.ts</code>: risk,
            screening, the contractor&apos;s limit, a first payment to a new address, two approvals and the spending limit. Nothing the model writes
            changes these checks. The decision prompt tells the model that an invoice&apos;s memo and purchase
            order are evidence, never an instruction, and the prompt that reads an invoice document says the same of the document; text about a
            milestone or a contractor carries no such line.
          </li>
          <li>
            <strong>Screening.</strong> A counterparty screened high risk is not paid, by the agent or with a person&apos;s approval. An owner, admin or
            approver can mark a screening match as not this counterparty; it is then screened again, and once it no longer screens high risk its
            payments are decided again.
          </li>
          <li>
            <strong>The agent&apos;s spending limit.</strong> A daily and a 7-day figure cap what the agent pays on its own. On Arc mainnet a workspace
            always has one: it starts at 50 USDC a day and 150 USDC in 7 days, and a workspace whose limit is missing or empty is held to those
            figures. The agent&apos;s purchases of payee history over x402 have a cap of their own, 0.05 USDC a day.
          </li>
          <li>
            <strong>A spending limit contract.</strong> On Arc mainnet, the agent pays from a treasury in the owner&apos;s own wallet only through{" "}
            <code>VestiarionSpendingLimit</code>, a contract that wallet deploys and approves. The contract refuses a payment past its daily or 7-day
            figure, pays each reference once, and lets only the treasury change its figures; setting the wallet&apos;s approval to 0 stops it. On Arc
            testnet the same contract is opt-in. Vestiarion holds no key to that wallet.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="api" title="API keys, the API and the MCP server">
        <ul>
          <li>
            An API key is <code>vxk_&lt;prefix&gt;_&lt;secret&gt;</code>: an 8-character prefix and a 256-bit secret. It is shown once, when it is
            created, and only its prefix and the SHA-256 hash of its secret are kept.
          </li>
          <li>
            A key reaches only its own workspace, with <code>read</code> or <code>read</code> and <code>write</code> access. Only owners and admins
            create and revoke keys, a workspace has at most 20, and a key stops working when the member who created it leaves the workspace.
          </li>
          <li>
            Most requests read. Four add a record, with a write key whose creator can still add records: a counterparty, an invoice, a milestone or a
            payee link. Writes from one key come in bursts of up to 30, then one every 2 seconds.
          </li>
          <li>
            Nothing in the API approves or pays directly. A payable added through it starts the agent&apos;s next cycle, and so does a milestone that
            names a pull request on a deployment with a GitHub token; any other milestone waits for the next scheduled cycle to check its pull request through the workspace&apos;s GitHub connection, or for a person to verify it. The agent decides what is
            added under the same rules and checks as in the app, so it may pay a counterparty whose address is confirmed, within its limits. An address given through the API is held as unconfirmed, so the agent pays nothing to it until a person confirms it. A new payee
            link replaces the counterparty&apos;s earlier one that was not used yet.
          </li>
          <li>The MCP server&apos;s tools are the same operations, under the same keys, and can do nothing the API cannot.</li>
        </ul>
      </LegalSection>

      <LegalSection id="chrome-extension" title="The Chrome extension and its tokens">
        <ul>
          <li>
            <strong>Connecting.</strong> The Chrome extension Vestiarion Invoice Capture connects with an OAuth authorization code and PKCE (S256
            only), for the extension ids the deployment lists in <code>CHROME_EXTENSION_IDS</code>, and, once it lists any, the copy offered for
            download, whose manifest&apos;s public key gives it one fixed id. Its one redirect address is exactly{" "}
            <code>https://&lt;id&gt;.chromiumapp.org/</code>; any other client or address is refused on the page and never redirected to, and the
            page cannot be framed. Only an owner or admin, whose role is read again, allows it, for one workspace.
          </li>
          <li>
            <strong>Tokens.</strong> A one-time code (<code>vxc_</code>, 5 minutes), an access token (<code>vxa_</code>, an hour) and a refresh
            token (<code>vxr_</code>, 30 days), each from 32 random bytes and kept only as a SHA-256 hash, in tables only the platform reads. Their
            audience is <code>vestiarion-chrome</code> and their scopes <code>invoice_draft:create</code> and <code>invoice_draft:read</code>: they
            create drafts and read the ones their connection made, and cannot add a bill, approve, pay or read any other record. They are not API
            keys: <code>/api/v1</code> and the MCP server refuse them.
          </li>
          <li>
            <strong>Rotation and revocation.</strong> Every refresh replaces both tokens. A code used twice, a replaced refresh token used again,
            or two refreshes with one token end the connection. A connection lasts at most 90 days from connecting, ends when its member can no
            longer add bills, and is deleted with the membership. The extension&apos;s Disconnect revokes it (RFC 7009), and Settings lists the
            connections, each with Disconnect. Each connection and its end are in the ledger, never a token.
          </li>
          <li>
            <strong>Its routes.</strong> The extension reaches only <code>/api/extension/v1</code>: the token and revoke endpoints and its draft
            endpoints. Each answers CORS only for <code>chrome-extension://&lt;id&gt;</code> of an allowed id and refuses any other origin with 403,
            authenticates by the token alone, never a cookie, checks its audience and scope, and reads the member&apos;s role again on every
            request. A capture (<code>POST</code>) carries an <code>Idempotency-Key</code>. A JSON body is at most 100 KB, counted as it is read;
            a file is at most 4 MB by the <code>Content-Length</code> it declares, and one sent without it is refused with 411. Draft requests from one connection come in bursts of up to 60, then one a second, and token or revoke requests from one address
            in bursts of up to 10, then one every 6 seconds. Answers are never cached.
          </li>
        </ul>
        <p>
          A draft becomes a bill only when an owner or admin adds it in the app, through the same checks as any bill. What the extension captures, and
          who reads it, is on the <LegalLink href="/privacy#chrome-extension">Privacy</LegalLink> page.
        </p>
      </LegalSection>

      <LegalSection id="connectors" title="Connected tools and their tokens">
        <ul>
          <li>
            <strong>Connecting.</strong> Only an owner or admin connects a workspace to Xero, QuickBooks Online, Zoho Books, HubSpot, Pipedrive,
            Zoho CRM, Asana, Slack or GitHub, and for the first seven only after agreeing to what Vestiarion reads and writes there. The OAuth state is
            signed under the master key and expires after 10 minutes, a nonce in an HttpOnly cookie must come back with it, and the callback is
            accepted only for the same signed-in person, whose role is read again.
          </li>
          <li>
            <strong>Zoho&apos;s data centers.</strong> The callback of Zoho Books and of Zoho CRM names the data center the person&apos;s Zoho account
            lives in. It is read only after every other check, and only from a fixed list of Zoho&apos;s data centers: the code, the client secret and
            the tokens go only to that data center&apos;s Zoho servers, never to an address the callback names, and each token is kept with its data
            center so it is never sent to another. Zoho CRM is called only at that data center&apos;s own API address, never at one an answer from
            Zoho names.
          </li>
          <li>
            <strong>BlindPay.</strong> Bank payouts run under the deployment&apos;s own BlindPay key, a server secret never stored in the database
            or shown in the browser. An owner sets a workspace up, and an owner or admin adds a vendor&apos;s bank account; its CLABE is checked, sent
            to BlindPay and not kept, only its bank and last four digits. Every payout is held for a person, takes exactly the bill&apos;s amount or
            sends nothing, and is asked for under a key derived from the payment&apos;s, so BlindPay makes it once. BlindPay&apos;s notices are
            accepted only under its Svix signature, within five minutes, and only start a cycle that reads the payout from BlindPay itself.
          </li>
          <li>
            <strong>Storing.</strong> The tokens of Xero, QuickBooks Online, Zoho Books, HubSpot, Pipedrive, Zoho CRM and Asana are encrypted, in a table
            only the platform reads, and are opened only in their own workspace&apos;s scope. They are never shown in the browser, a log, a model&apos;s prompt
            or a webhook.
          </li>
          <li>
            <strong>Refreshing.</strong> A token is refreshed a minute before it expires, under a lease in the database, so one refresh runs at a time
            for a connection, and a new token is stored only against the version that was read.
          </li>
          <li>
            <strong>Disconnecting.</strong> <strong>Disconnect</strong> revokes the grant at the provider, then deletes the tokens, even when the
            provider could not be reached, and records the disconnection in the ledger, best effort: a ledger write that fails does not stop it.
            Asana&apos;s webhooks are deleted before its grant is revoked, and revoking Pipedrive&apos;s grant uninstalls the app from the company, as
            Pipedrive documents it.
          </li>
          <li>
            <strong>Disconnected on the provider&apos;s side.</strong> When someone disconnects QuickBooks Online at Intuit, its Disconnect page asks
            Intuit whether the connection still works, and deletes the tokens once Intuit refuses them. Pipedrive&apos;s notice that the app was
            uninstalled marks the connection to be connected again and keeps its tokens, which no longer work. Zoho sends no notice: access removed
            in Zoho is found when the next sync&apos;s refresh is refused, which marks the connection the same way.
          </li>
          <li>
            <strong>Slack</strong> keeps its bot token and posting address encrypted. Disconnecting uninstalls the app from the Slack workspace, which
            revokes both, and deletes them; Slack&apos;s own uninstall and revocation notices delete them too.
          </li>
          <li>
            <strong>GitHub</strong> is a GitHub App, and Vestiarion stores no token for it. Disconnecting deletes the installation&apos;s record; the
            app&apos;s access ends when it is uninstalled on GitHub.
          </li>
          <li>
            <strong>Deleting a workspace</strong>, from its Settings or with its last member&apos;s account, deletes its tokens, its Slack connection and
            its GitHub record without calling any provider or uninstalling the Slack app, so disconnect each tool first to revoke its grant there.
          </li>
        </ul>
        <p>
          What Vestiarion reads from and writes to each tool is on the <LegalLink href="/privacy#services">Privacy</LegalLink> page. QuickBooks
          Online is never written to, though the access Intuit grants could. Zoho Books and Zoho CRM are never written to, and the access Zoho grants
          each is read only.
        </p>
      </LegalSection>

      <LegalSection id="webhooks" title="Webhooks and scheduled jobs">
        <p>Each webhook Vestiarion receives is checked as follows, and every shared secret is compared in constant time:</p>
        <ul>
          <li>
            <strong>Circle</strong>: an ECDSA P-256 signature over the body, checked against Circle&apos;s public key for the key id it names. Circle&apos;s
            test notification is answered without a check and starts nothing. For any other, the body names the payment or wallet, which is looked up
            first; a cycle starts only after the signature verifies;
          </li>
          <li>
            <strong>QuickBooks Online</strong>: an HMAC-SHA256 of the body, under the app&apos;s verifier token;
          </li>
          <li>
            <strong>Pipedrive</strong>: a deal notice carries HTTP Basic credentials derived for each company, checked before the body is read, and its
            body is never used; the notice that the app was uninstalled carries the app&apos;s own client id and secret as HTTP Basic credentials, and
            only its company id is read;
          </li>
          <li>
            <strong>Asana</strong>: the handshake secret, accepted once, for a webhook Vestiarion just created, then an HMAC-SHA256 of each body under
            that secret, kept encrypted;
          </li>
          <li>
            <strong>Slack</strong>: an HMAC-SHA256 over the timestamp and the body, refused when the timestamp is more than 5 minutes away;
          </li>
          <li>
            <strong>GitHub</strong>: an HMAC-SHA256 of the body;
          </li>
          <li>
            <strong>Telegram</strong>: the secret token set for the bot;
          </li>
          <li>
            <strong>Resend</strong>, for invoices by email: a Svix signature, refused when its timestamp is more than 5 minutes away.
          </li>
        </ul>
        <p>Xero, Zoho Books, HubSpot and Zoho CRM send Vestiarion no webhooks: their records are read on a schedule.</p>
        <p>
          The scheduled routes, the agent&apos;s tick, the FX and transfer watches, webhook delivery, accounting sync, the daily cleanup and the FX
          rates, take the deployment&apos;s <code>AGENT_API_TOKEN</code> as a bearer token, compared as SHA-256 digests in constant time. So does the
          demo reset, which is not scheduled: it also needs a typed confirmation, and is refused in production unless the deployment allows it.
        </p>
        <p>
          The webhooks Vestiarion sends carry <code>Vestiarion-Signature</code>, an HMAC-SHA256 over a timestamp and the body under the
          endpoint&apos;s 256-bit secret, which is encrypted at rest. An endpoint must be HTTPS on port 443, with no credentials in its address, and
          every address it resolves to must be public: the address is checked and pinned when each delivery connects, and redirects are not followed,
          so a webhook cannot be pointed at Vestiarion&apos;s own network. A delivery waits at most 10 seconds and is tried up to 7 times; an endpoint
          that fails 20 times in a row is disabled. A workspace has at most 5 active endpoints. The{" "}
          <LegalLink href="/docs/webhooks/verify">verification guide</LegalLink> has the check for a receiver.
        </p>
      </LegalSection>

      <LegalSection id="audit" title="The signed ledger">
        <ul>
          <li>
            Each workspace signs its ledger with its own Ed25519 key, made when the workspace is created and encrypted as above. An entry&apos;s body
            hash is the SHA-256 of the canonical JSON of its actor, domain, action, summary and detail; its signature is over that hash; and its
            hash covers the previous entry&apos;s hash, its body hash and its signature. So changing any of those in an entry breaks every link after
            it. An entry&apos;s time, sequence number and signing key id are outside the hashes.
          </li>
          <li>
            The database role a workspace&apos;s requests run as can only read and add ledger entries, never change or delete one. For that role, a
            database trigger takes the workspace&apos;s ledger lock and refuses an entry whose previous hash is not the current head, or whose hash is
            not the hash of its previous hash, body hash and signature. The trigger does not check the signature or the body hash; the verifier does.
            The sequence number is assigned by the database, and gaps in it are normal.
          </li>
          <li>
            Any member can check the whole chain with <strong>Verify hash chain</strong> on the Audit log, and an API key can ask the same through{" "}
            <code>GET /api/v1/ledger/verify</code>.
          </li>
          <li>
            The ledger exports as JSON, each entry with its signature and the public keys that vouch for them; the file itself is not signed. A{" "}
            <LegalLink href="/docs/guides/audit-export">standalone verifier</LegalLink>, one file with no dependencies, checks an export without
            Vestiarion, and so does the CLI. Each export is recorded in the ledger, best effort.
          </li>
          <li>
            An owner can rotate a workspace&apos;s signing key. The retired public keys are kept, so earlier entries still verify, and the rotation is
            an entry signed by the new key.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="retention" title="Data retention and deletion">
        <ul>
          <li>
            A sandbox workspace with no activity for 60 days is deleted by a daily cleanup, unless it holds Circle credentials, a hosted wallet or a
            contract its owner&apos;s wallet deployed. A webhook delivery is deleted 30 days after it is delivered, or after it was created if it
            failed. The outcome of an API write sent with an <code>Idempotency-Key</code>, its response included, is given back for 24 hours, and
            deleted by the daily cleanup after that. Everything else in a workspace is kept until the workspace is deleted, or until a person removes
            it: disconnecting a tool, removing sample data or turning a feature off deletes what it held.
          </li>
          <li>
            Text captured with the Chrome extension is removed when its draft is added or discarded, and 30 days after capture at the latest; a
            draft never sent for review is deleted within 7 days, and a file it sent is never kept, only its SHA-256. A Chrome extension connection is
            deleted 30 days after it ended or expired, and a one-time sign-in code a day after it expired.
          </li>
          <li>
            An owner deletes a workspace from its Settings. Its records, ledger, API keys, webhooks, connector tokens, members and invitations are deleted
            in one step. A tombstone only the platform reads keeps its slug and name, who deleted it and when, and its ledger&apos;s length, head hash
            and signing key id. Its wallets and their USDC stay where they are held. The Vestiarion team&apos;s own records of a business it is in
            touch with, its lead and any revenue recorded for it, stay: their link to the workspace is cleared, and the lead&apos;s history keeps the
            workspace&apos;s id.
          </li>
          <li>
            Anyone can delete their own account from the account menu, within the rules Privacy gives. A workspace where they are the only member is
            deleted with it, as above. In a workspace they share, their membership, the invitations they sent, the payment approvals they gave
            and their Slack and Telegram links go; the API keys they created are revoked and kept without their name; and the connections they made
            and the records they added stay, without their name. The ledger entries they caused keep their account&apos;s id, never their email, because the ledger is append-only.
          </li>
          <li>
            After a tool is disconnected, the records already read from it stay with the workspace, and the ledger keeps only ids and names from it.
          </li>
        </ul>
        <p>
          <LegalLink href="/privacy#retention">Privacy</LegalLink> has the rest, including what a workspace stores and the rules for deleting an
          account.
        </p>
      </LegalSection>

      <LegalSection id="ai" title="AI use">
        <ul>
          <li>
            The agent&apos;s model provider is Anthropic, OpenAI or DeepSeek, whichever this deployment configures. It receives what{" "}
            <LegalLink href="/privacy#services">Privacy</LegalLink> lists: the facts of each decision it is asked about; for each email that reaches a
            workspace&apos;s invoice address, its first PDF, .eml or .txt attachment, or else its text, and nothing for one that is too large, holds
            only images or comes over the workspace&apos;s rate; each document a member has it read; and each plain-text message a linked member
            sends the Telegram bot. Without a provider, a written rule-based policy decides, and nothing is sent.
          </li>
          <li>
            Each provider handles these requests under its own API terms:{" "}
            {MODEL_PROVIDER_TERMS.map((provider, index) => (
              <span key={provider.name}>
                {index > 0 ? (index === MODEL_PROVIDER_TERMS.length - 1 ? " and " : ", ") : ""}
                <LegalLink href={provider.href}>{provider.name}</LegalLink>
              </span>
            ))}
            . Someone running their own copy can point <code>ANTHROPIC_BASE_URL</code>, which Anthropic&apos;s SDK reads, at another
            Anthropic-compatible host, and <code>OPENAI_BASE_URL</code> or <code>DEEPSEEK_BASE_URL</code> at another OpenAI-compatible one.
          </li>
          <li>
            A model&apos;s answer must parse against a fixed schema. An answer that does not is shown its error once, and if it still fails, the
            rule-based policy decides and the ledger says so. Either way, the answer is a proposal the rules in code check.
          </li>
          <li>
            Vestiarion trains and fine-tunes no model, and never uses data from Xero, QuickBooks, Zoho Books, HubSpot, Pipedrive, Zoho CRM or Asana to
            train or improve any AI model.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="subprocessors" title="Subprocessors">
        <p>
          As of <time dateTime={SUBPROCESSORS_AS_OF}>{SUBPROCESSORS_AS_OF}</time>, these services process data for Vestiarion. Some receive data only
          when this deployment configures them or someone connects them. <LegalLink href="/privacy#services">Privacy</LegalLink> says in full
          what each receives.
        </p>
        <ul>
          {SUBPROCESSORS.map((service) => (
            <li key={service.name}>
              <strong>{service.name}</strong>: {service.purpose}
              {service.when ? `, ${service.when}` : ""}. Data: {service.data}.
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection id="development" title="Secure development">
        <ul>
          <li>
            The code is public on <LegalLink href={GITHUB_URL}>GitHub</LegalLink> under the MIT License. Changes reach <code>main</code> through pull
            requests, and Vercel deploys <code>main</code>.
          </li>
          <li>
            Changes are reviewed by an independent AI code reviewer before merge, and every defect it finds is fixed with a test that fails first; when a
            release&apos;s changes were not each reviewed so, its release notes say so. Each change must pass CI before it is merged.
          </li>
          <li>
            <LegalLink href={CI_URL}>CI</LegalLink> runs on every pull request and every push to <code>main</code>: it checks that the lockfile
            describes the dependencies, type-checks, lints, runs the test suite and builds the app. It needs no secret.
          </li>
          <li>
            The tests cover the ledger&apos;s tamper cases, the rules in code, tenant isolation and every migration, run on an in-process Postgres.
            Others hold the docs to the code: the webhook verification snippets run against the signing code, and this page and the privacy page are
            checked against the figures and settings they quote.
          </li>
          <li>
            Secrets live in the deployment&apos;s environment, never in the repository: environment files are ignored by git, and the one committed
            example holds placeholders and no secrets. GitHub secret scanning, with push protection, is on for the repository.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="incidents" title="Incident response">
        <p>What can be done at once when something goes wrong:</p>
        <ul>
          <li>
            Payments can be switched off for every workspace from the database, which every running deployment reads within 10 seconds, with no
            redeploy, or by the deployment&apos;s environment and a redeploy. While they are off, Vestiarion sends nothing that moves money, a
            person&apos;s approval included; what an owner&apos;s own wallet signs in their browser, and payments made to Vestiarion over x402, are not
            stopped by it. Payments on Arc mainnet can be held on their own, by an environment change and a redeploy. Reads and every page keep
            working.
          </li>
          <li>
            In a workspace, any owner, admin or approver can pause the agent: it then runs no cycle and pays nothing on its own, while a person can
            still approve and pay. On Arc mainnet, an owner&apos;s wallet can set its approval for the spending limit contract to 0.
          </li>
          <li>
            An owner can rotate the workspace&apos;s ledger signing key, and an owner or admin can revoke an API key. Disconnecting a tool revokes
            its grant, except GitHub, whose app is uninstalled on GitHub, since Vestiarion holds no grant for it.
          </li>
        </ul>
        <p>When an incident affects workspaces, we tell their owners what happened and what we changed.</p>
      </LegalSection>

      <LegalSection id="report" title="Reporting a vulnerability">
        <p>
          Please report a vulnerability privately, with <LegalLink href={SECURITY_ADVISORY_URL}>Report a vulnerability</LegalLink> under the
          repository&apos;s Security tab on GitHub, and not in a public issue. The <LegalLink href={SECURITY_POLICY_URL}>security policy</LegalLink>{" "}
          says what is in scope and what to expect.
        </p>
      </LegalSection>

      <LegalSection id="not-claimed" title="What we do not claim">
        <ul>
          <li>Vestiarion holds no SOC 2 report or ISO 27001 certification, and has had no outside security audit or penetration test.</li>
          <li>
            The contracts, <code>VestiarionSpendingLimit</code>, its version 2 <code>VestiarionSpendingLimitV2</code> and <code>VestiarionEscrow</code>, were written for Vestiarion and have not been audited.
          </li>
          <li>Vestiarion is in beta. It changes every day and is provided as is, as the <LegalLink href="/terms">Terms</LegalLink> say.</li>
          <li>
            The master keys are a deployment secret, not held in a hardware security module. Someone who took over Vestiarion&apos;s server could use
            them, and move money from the wallets Vestiarion reaches through Circle: hosted wallets, and those in a Circle account a workspace
            connected. A limit enforced on Arc keeps the agent within its figures, but does not stop that. A treasury in the owner&apos;s own wallet
            on Arc mainnet is reachable only through its contract, within its figures.
          </li>
          <li>
            The ledger is not anchored on chain. A copy kept outside Vestiarion, an export or a webhook receiver&apos;s, is what shows its history was
            not rewritten by someone in control of the server.
          </li>
          <li>
            <code>main</code> has no branch protection and no required human second approval: the independent AI review and CI before each merge
            are how the team works, not a rule GitHub enforces. Dependencies are not updated automatically.
          </li>
          <li>
            Rate limits are kept by each server instance, so they slow abuse rather than set a hard quota, and API reads are not limited.
          </li>
          <li>
            The app does not send a Content Security Policy yet, except <code>frame-ancestors &apos;none&apos;</code> on the Chrome extension&apos;s
            sign-in page, so that page cannot be framed.
          </li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
