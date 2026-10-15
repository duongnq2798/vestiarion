import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { CI_URL, GITHUB_URL, ISSUES_URL, SECURITY_POLICY_URL } from "@/lib/site-links";
import { SUBPROCESSORS, SUBPROCESSORS_AS_OF, WHEN_WORDS } from "@/lib/subprocessors";

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
      updated="2026-10-15"
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
            gave them, and tell Vestiarion about changes with signed webhooks. A request is checked by its session, its key, its signature or the
            token of a shared link before it reaches any data, and a person&apos;s role decides what they may do.
          </li>
          <li>
            <strong>Stored.</strong> A workspace&apos;s records are rows in Postgres that only a request for that workspace can reach, as{" "}
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
        <p>One workspace&apos;s data never reaches another&apos;s request, by two independent lines:</p>
        <ul>
          <li>
            <strong>In the server.</strong> Workspace data is read and written only through one data access layer, which adds the workspace to every
            query and every insert, and refuses a row that names another workspace. Linting forbids importing the database&apos;s service-role client
            anywhere else.
          </li>
          <li>
            <strong>In the database.</strong> Each request for a workspace runs as a dedicated Postgres role, with a token the server signs for that
            request alone: it names the workspace and the person, and expires after 5 minutes. There is no fallback to the service role. Every
            workspace table that role can reach has row-level security with a restrictive policy that holds it to the token&apos;s workspace,
            whatever other policy is added later.
          </li>
        </ul>
        <p>
          The roles a browser session or an anonymous visitor carries hold no privileges on the tables at all. Links between workspace records are
          foreign keys that include the workspace, so the database refuses a link into another workspace&apos;s row. The platform&apos;s own tables,
          such as memberships, API keys and connector tokens, are reached with the service role through an allowlist of tables and functions, and
          grant the workspace role nothing.
        </p>
      </LegalSection>

      <LegalSection id="encryption" title="Encryption">
        <p>
          The app and its API are served over HTTPS. Secrets are encrypted in the app before they reach the database, with AES-256-GCM and a fresh
          96-bit IV for each one, under a master key the deployment holds as a secret. Each ciphertext is bound to its workspace and its field, and
          connector tokens and webhook secrets to their row too, so a copy moved anywhere else does not decrypt. Encrypted this way:
        </p>
        <ul>
          <li>the Circle API key and entity secret a workspace connects;</li>
          <li>each workspace&apos;s Ed25519 ledger signing key;</li>
          <li>each webhook endpoint&apos;s signing secret, and the secret of each webhook Asana sends;</li>
          <li>the OAuth access and refresh tokens of Xero, QuickBooks Online, HubSpot, Pipedrive and Asana;</li>
          <li>a Slack connection&apos;s bot token and posting address;</li>
          <li>the token of a client&apos;s pay link kept for its reminders.</li>
        </ul>
        <p>
          Each envelope names the master key that sealed it. The first key listed encrypts and any listed key decrypts, so a new master key can be
          added without breaking what an older one sealed.
        </p>
        <p>
          Some secrets are kept only as a SHA-256 hash: an API key&apos;s 256-bit secret, beside its prefix, compared in constant time, and the
          tokens of shared receipt, report and payee links. Some are never stored: the GitHub token of the person connecting GitHub is used once and
          dropped, a GitHub App installation&apos;s tokens are made for each run and kept in memory, and the password Pipedrive sends with its webhooks
          is derived from the master key for each company.
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
            <strong>Maker and checker.</strong> Owners and admins add records; owners, admins and approvers decide the payments the agent held. An
            accountant books payments but decides none, and a viewer only reads.
          </li>
          <li>
            <strong>No self-approval.</strong> The database&apos;s approval function refuses an approval by the person who created the invoice. The one
            exception is a workspace where that person is the only owner, admin or approver; the ledger records that they approved it. A partner named
            on a commission plan never approves the payable that pays them, even then.
          </li>
          <li>
            <strong>A first payment to a new address.</strong> Where payments are real, the agent never makes a first payment to an address that only
            the person who gave it stands behind, and that person cannot approve it either.
          </li>
          <li>
            <strong>Two approvals.</strong> Above a figure the owner sets, a payment needs two different people, and one person cannot give both. A
            workspace with a single approver cannot pay above the figure until it is raised or another approver joins. On Arc mainnet a workspace
            starts with two approvals above 100 USDC, and the figure can be raised but not turned off.
          </li>
          <li>
            <strong>Rules in code the model cannot override.</strong> Every payment the agent would make passes the checks in{" "}
            <code>src/lib/agent/guardrails.ts</code> after the model has answered. They hold or refuse a payment to a counterparty screened high risk,
            one not screened yet, one without a payment address or with an address no one confirmed, a duplicate of a bill already paid, a bill missing
            its purchase order or goods receipt, a payment above the counterparty&apos;s limit, above the two-approvals figure or past the agent&apos;s
            spending limit. A counterparty screened high risk is never paid, not even with a person&apos;s approval. Nothing the model writes changes
            these checks, and the model is told that text from a bill or a document is evidence, never an instruction.
          </li>
          <li>
            <strong>The agent&apos;s spending limit.</strong> A daily and a 7-day figure cap what the agent pays on its own. On Arc mainnet a workspace
            always keeps one, starting at 50 USDC a day and 150 USDC in 7 days.
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
            An API key is <code>vxk_</code>, an 8-character prefix and a 256-bit secret. It is shown once, when it is created, and only its prefix and
            the SHA-256 hash of its secret are kept.
          </li>
          <li>
            A key reaches only its own workspace, with <code>read</code> or <code>read</code> and <code>write</code> access. Only owners and admins
            create and revoke keys, a workspace has at most 20, and a key stops working when the member who created it leaves the workspace.
          </li>
          <li>
            Most requests read. Four add a record, with a write key whose creator can still add records: a counterparty, an invoice, a milestone or a
            payee link. Writes are limited to 30 a minute for each key. No request approves a payment, moves money, or changes or removes a record, and
            an address given through the API is held as unconfirmed, so the agent pays nothing to it until a person confirms it.
          </li>
          <li>The MCP server&apos;s tools are the same operations, under the same keys, and can do nothing the API cannot.</li>
        </ul>
      </LegalSection>

      <LegalSection id="connectors" title="Connected tools and their tokens">
        <ul>
          <li>
            <strong>Connecting.</strong> Only an owner or admin connects a workspace to Xero, QuickBooks Online, HubSpot, Pipedrive, Asana, Slack or
            GitHub, and for the first five only after agreeing to what Vestiarion reads and writes there. The OAuth state is signed under the master
            key and expires after 10 minutes, a nonce in an HttpOnly cookie must come back with it, and the callback is accepted only for the same
            signed-in person, whose role is read again.
          </li>
          <li>
            <strong>Storing.</strong> The tokens of Xero, QuickBooks Online, HubSpot, Pipedrive and Asana are encrypted, in a table only the platform
            reads, and are opened only in their own workspace&apos;s scope. They are never shown in the browser, a log, a model&apos;s prompt or a
            webhook.
          </li>
          <li>
            <strong>Refreshing.</strong> A token is refreshed a minute before it expires, under a lease in the database, so one refresh runs at a time
            for a connection, and a new token is stored only against the version that was read.
          </li>
          <li>
            <strong>Disconnecting.</strong> Disconnecting revokes the grant at the provider, then deletes the tokens and records the disconnection in
            the ledger. Pipedrive&apos;s revocation uninstalls Vestiarion from the company, and Asana&apos;s webhooks are deleted before its grant is
            revoked. The tokens are deleted even when the provider cannot be reached, or says it was disconnected there first.
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
            <strong>Deleting a workspace</strong> deletes its tokens with it, without calling the providers, so disconnect a tool first to revoke its
            grant there.
          </li>
        </ul>
        <p>
          What Vestiarion reads from and writes to each tool is on the <LegalLink href="/privacy#services">Privacy</LegalLink> page. QuickBooks
          Online is never written to, though the access Intuit grants could.
        </p>
      </LegalSection>

      <LegalSection id="webhooks" title="Webhooks">
        <p>Every webhook Vestiarion receives is verified before it is acted on, and shared-secret signatures are compared in constant time:</p>
        <ul>
          <li>
            <strong>Circle</strong>: an ECDSA P-256 signature over the body, checked against Circle&apos;s public key for the key id it names;
          </li>
          <li>
            <strong>QuickBooks Online</strong>: an HMAC-SHA256 of the body, under the app&apos;s verifier token;
          </li>
          <li>
            <strong>Pipedrive</strong>: HTTP Basic credentials derived for each company, checked before the body is read, and the body is never used;
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
        <p>Xero and HubSpot send Vestiarion no webhooks: their records are read on a schedule.</p>
        <p>
          The webhooks Vestiarion sends carry <code>Vestiarion-Signature</code>, an HMAC-SHA256 over a timestamp and the body under the
          endpoint&apos;s 256-bit secret, which is encrypted at rest. An endpoint must be HTTPS on port 443, with no credentials in its address, and
          every address it resolves to must be public: the address is checked and pinned when each delivery connects, and redirects are not followed,
          so a webhook cannot be pointed at Vestiarion&apos;s own network. A delivery waits at most 10 seconds and is tried up to 7 times; an endpoint
          that fails 20 times in a row is disabled. A workspace has at most 5 endpoints. The{" "}
          <LegalLink href="/docs/webhooks/verify">verification guide</LegalLink> has the check for a receiver.
        </p>
      </LegalSection>

      <LegalSection id="audit" title="The signed ledger">
        <ul>
          <li>
            Each workspace signs its ledger with its own Ed25519 key, made when the workspace is created and encrypted as above. An entry&apos;s body
            hash is the SHA-256 of the canonical JSON of what it records; its signature is over that hash; and its hash covers the previous
            entry&apos;s hash, its body hash and its signature, so changing any entry breaks every link after it.
          </li>
          <li>
            The database role a workspace&apos;s requests run as can only read and add ledger entries, never change or delete one, and a database
            trigger refuses an entry that does not extend the chain.
          </li>
          <li>
            Any member can check the whole chain with <strong>Verify hash chain</strong> on the Audit log, and an API key can ask the same through{" "}
            <code>GET /api/v1/ledger/verify</code>.
          </li>
          <li>
            The ledger exports as signed JSON, and a <LegalLink href="/docs/guides/audit-export">standalone verifier</LegalLink>, one file with no
            dependencies, checks an export without Vestiarion; so does the CLI. Each export is itself recorded in the ledger.
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
            failed. Everything else in a workspace is kept until the workspace is deleted.
          </li>
          <li>
            An owner deletes a workspace from its Settings. Its records, ledger, API keys, webhooks, connector tokens, members and invitations are deleted
            in one step. A tombstone only the platform reads keeps its slug and name, who deleted it and when, and its ledger&apos;s length, head hash
            and signing key id. Its wallets and their USDC stay where they are held.
          </li>
          <li>
            Anyone can delete their own account from the account menu, within the rules Privacy gives. A workspace where they are the only member is
            deleted with it; their
            memberships, invitations and API keys go; records they added in shared workspaces stay without their name. In a workspace that stays,
            the ledger entries they caused keep their account&apos;s id, never their email, because the ledger is append-only.
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
            The agent&apos;s model provider is Anthropic, OpenAI or DeepSeek, whichever this deployment configures. It receives, through its API,
            only what <LegalLink href="/privacy#services">Privacy</LegalLink> lists: the facts of each decision it is asked about, and a document or a
            message a member chooses to have read. Without a provider, a written rule-based policy decides, and nothing is sent.
          </li>
          <li>
            A model&apos;s answer must parse against a fixed schema. An answer that does not is shown its error once, and if it still fails, the
            rule-based policy decides and the ledger says so. Either way, the answer is a proposal the rules in code check.
          </li>
          <li>
            Vestiarion trains and fine-tunes no model. It never uses data from Xero, QuickBooks, HubSpot, Pipedrive or Asana to train or improve any AI
            model, and the provider may not train on the facts of a bill or a deal it sees.
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
              {WHEN_WORDS[service.when] ? `, ${WHEN_WORDS[service.when]}` : ""}. Data: {service.data}.
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
            <LegalLink href={CI_URL}>CI</LegalLink> runs on every pull request and every push to <code>main</code>: it checks that the lockfile
            describes the dependencies, type-checks, lints, runs the test suite and builds the app. It needs no secret.
          </li>
          <li>
            The tests cover the ledger&apos;s tamper cases, the rules in code, tenant isolation and every migration, run on an in-process Postgres.
            Others hold the docs to the code: the webhook verification snippets run against the signing code, and this page and the privacy page are
            checked against the figures and settings they quote.
          </li>
          <li>
            Secrets live in the deployment&apos;s environment, never in the repository: environment files are ignored by git, and only an example with
            empty values is committed. GitHub secret scanning, with push protection, is on for the repository.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="incidents" title="Incident response">
        <p>What can be done at once when something goes wrong:</p>
        <ul>
          <li>
            Payments can be switched off for every workspace from the database, which every running deployment reads within 10 seconds, with no
            redeploy, or by the deployment&apos;s environment. Payments on Arc mainnet can be held on their own. Reads and every page keep working.
          </li>
          <li>
            In a workspace, any owner, admin or approver can pause the agent; it then runs no cycle and moves no money. On Arc mainnet, an owner&apos;s
            wallet can set its approval for the spending limit contract to 0.
          </li>
          <li>
            An owner can rotate the workspace&apos;s ledger signing key, an owner or admin can revoke an API key, and disconnecting a tool revokes its
            grant.
          </li>
        </ul>
        <p>When an incident affects workspaces, we tell their owners what happened and what we changed.</p>
      </LegalSection>

      <LegalSection id="report" title="Reporting a vulnerability">
        <p>
          Please do not put the details of a vulnerability in a public issue. Open an issue on{" "}
          <LegalLink href={ISSUES_URL}>GitHub Issues</LegalLink> titled <strong>Security contact</strong>, with no details, and a maintainer opens a
          private GitHub security advisory and invites you to it, where you send the details. The{" "}
          <LegalLink href={SECURITY_POLICY_URL}>security policy</LegalLink> says what is in scope and what to expect.
        </p>
      </LegalSection>

      <LegalSection id="not-claimed" title="What we do not claim">
        <ul>
          <li>Vestiarion holds no SOC 2 report or ISO 27001 certification, and has had no outside security audit or penetration test.</li>
          <li>
            The contracts, <code>VestiarionSpendingLimit</code> and <code>VestiarionEscrow</code>, were written for Vestiarion and have not been audited.
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
            Merging to <code>main</code> is not gated by branch protection: changes go through pull requests and CI, and no second reviewer is required.
            Dependencies are not updated automatically.
          </li>
          <li>Rate limits are kept by each server instance, so they slow abuse rather than set a hard quota, and API reads are not limited.</li>
          <li>The app does not send a Content Security Policy yet.</li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
