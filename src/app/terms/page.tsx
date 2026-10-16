import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { HOSTED_MODEL_PROVIDER } from "@/lib/connectors/consent";
import { ISSUES_URL, LICENSE_URL } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms for using Vestiarion: it pays in USDC on Arc mainnet and Arc testnet, you choose where the money is held, it is provided as is, and its code is MIT licensed.",
  alternates: { canonical: "/terms" },
};

/**
 * The terms of use (spec §2, F2). Static and public. Each statement describes
 * what the service does today; `tests/legal-pages.test.tsx` holds the page to
 * its topics, and reads the figures it quotes from the code.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      updated="2026-10-16"
      intro="These terms cover your use of Vestiarion, an autonomous treasury agent that pays invoices and contractors in USDC on Arc mainnet and Arc testnet. By using it, you accept them."
    >
      <LegalSection id="networks" title="Arc mainnet and Arc testnet">
        <p>Each workspace runs on one network, chosen when it is created, and never moves to the other.</p>
        <ul>
          <li>
            <strong>Arc mainnet</strong>: the workspace pays in real USDC. Nothing moves until an owner takes it live, typing <code>mainnet</code> to confirm. From
            then on, every payment the agent makes, or a person approves, moves real USDC, and a transfer on chain cannot be taken back.
          </li>
          <li>
            <strong>Arc testnet</strong>: the workspace pays in testnet USDC and EURC from Circle&apos;s faucet. Shadow mode, hosted wallets, the USYC reserve,
            milestone escrow, the EURC swap and payouts to other chains run here only.
          </li>
        </ul>
        <p>On both networks, the agent&apos;s payments are sent through Circle Developer-Controlled Wallets.</p>
      </LegalSection>

      <LegalSection id="custody" title="Where the money is">
        <p>Who holds a workspace&apos;s USDC depends on the treasury its owner chose:</p>
        <ul>
          <li>
            <strong>Your own wallet or passkey wallet</strong>, on Arc mainnet: the USDC stays in a wallet you hold, and Vestiarion holds no key to it. The agent
            pays from it only through a spending limit contract your wallet deploys and approves, within the daily and 7-day figures set in it. Your wallet
            changes those figures, and stops the agent by setting its approval to 0. The agent&apos;s own wallet, which holds only its gas, is in
            Vestiarion&apos;s Circle account.
          </li>
          <li>
            <strong>Your own Circle account</strong>, on either network: the wallets are in your Circle account, and Vestiarion moves their USDC with the API key
            and entity secret you connect, which it stores encrypted.
          </li>
          <li>
            <strong>Hosted wallets</strong>, on Arc testnet only: the wallets are created in Vestiarion&apos;s own Circle testnet account, so Vestiarion holds
            them.
          </li>
        </ul>
        <p>The contracts were written for Vestiarion and have not been audited.</p>
      </LegalSection>

      <LegalSection id="the-software" title="The software">
        <p>
          Vestiarion&apos;s code is released under the <LegalLink href={LICENSE_URL}>MIT License</LegalLink>, and its source is public on GitHub. These terms
          cover the hosted service; the license covers the code.
        </p>
      </LegalSection>

      <LegalSection id="as-is" title="Provided as is">
        <p>
          The service is provided as is, without warranty of any kind. It may be unavailable, have bugs, or lose data, and it depends on Arc and on Circle,
          which can be unavailable too. As far as the law allows, its contributors are not liable for any loss that comes from using it, including a payment
          the agent made within the limits your workspace set, or one made to the address recorded for a counterparty.
        </p>
      </LegalSection>

      <LegalSection id="your-responsibilities" title="Your responsibilities">
        <p>You are responsible for:</p>
        <ul>
          <li>the Circle credentials you connect: they are your own, so keep them safe, and rotate them if they leak;</li>
          <li>
            on Arc mainnet, the wallet or passkey that holds your treasury, and its recovery phrase if you saved one: Vestiarion cannot recover either, and will
            never ask for the phrase;
          </li>
          <li>your counterparties&apos; wallet addresses: the agent pays the address recorded for a counterparty, and a transfer on chain cannot be taken back;</li>
          <li>
            your workspace&apos;s guardrails: the payment limits, the two-approval figure and the agent&apos;s spending limit you set decide what the agent may
            pay on its own, and what it holds for a person;
          </li>
          <li>who you invite to your workspace, and the role you give them;</li>
          <li>
            the accounting tool you connect, such as a Xero organisation, a QuickBooks company or a Zoho Books organization: connect only one you may give
            a workspace access to;
          </li>
          <li>
            the CRM you connect, such as a HubSpot account, a Pipedrive company or a Zoho CRM organization: connect only one you may give a workspace
            access to;
          </li>
          <li>
            the work tool you connect, such as your Asana, and the acceptance criteria you write: a person in your workspace, never Asana, accepts a
            contractor&apos;s work against them;
          </li>
          <li>using the service lawfully where you and the people you pay are, including any rules on paying in stablecoins.</li>
        </ul>
      </LegalSection>

      <LegalSection id="accounting-tools" title="Connected accounting tools">
        <p>
          When an owner or admin connects Xero to a workspace, they agree, for the workspace, that Vestiarion reads the bills, suppliers and chart of
          accounts of the Xero organisation they pick. It writes to Xero only the payments an owner, admin or accountant approves, each booked against the bill it
          paid, and books a payment on Arc testnet or in shadow mode only into a Xero demo company. The bills a person adds are shown to the workspace&apos;s members and
          to its agent; the agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) sees each bill&apos;s facts to decide on it,
          under {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>.
        </p>
        <p>
          Vestiarion never uses Xero data to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. A bill
          approved in Xero is not a payment approved in Vestiarion: the agent decides it within the workspace&apos;s guardrails, as any other.
          Disconnecting stops the reading at once; the bills already added stay with the workspace.
        </p>
        <p>
          When an owner or admin connects QuickBooks Online to a workspace, they agree, for the workspace, that Vestiarion reads the bills, vendors and
          bank accounts of the QuickBooks company they connect. It writes nothing to QuickBooks, though the access Intuit grants could. A QuickBooks
          company connects to one workspace at a time. The bills a person adds are shown to the workspace&apos;s members and to its agent; the
          agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) sees each bill&apos;s facts to decide on it, under{" "}
          {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>. Vestiarion never uses QuickBooks data, or any
          data from Intuit, to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. A bill open in
          QuickBooks is not a payment approved in Vestiarion. Disconnecting, here or in QuickBooks, stops the reading at once; the bills already added
          stay with the workspace.
        </p>
        <p>
          When an owner or admin connects Zoho Books to a workspace, they agree, for the workspace, that Vestiarion reads the bills and vendors of the
          Zoho Books organization they pick, and the names of the organizations they can reach. It writes nothing to Zoho Books, and the access Zoho
          grants is read only. The bills a person adds are shown to the workspace&apos;s members and to its agent; the
          agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) sees each bill&apos;s facts to decide on it, under{" "}
          {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>. Vestiarion never uses Zoho Books data to train or improve any
          AI model, and never passes it to anyone else without the workspace&apos;s say. A bill open or approved in Zoho Books is not a payment
          approved in Vestiarion. Zoho Books does not tell Vestiarion when a bill is deleted there, so a bill you added and then deleted in Zoho Books
          is yours to reject in Vestiarion. Disconnecting, here or in Zoho, stops the reading at once; the bills already added stay with the
          workspace.
        </p>
        <p>
          When an owner or admin connects HubSpot to a workspace, they agree, for the workspace, that Vestiarion reads the companies, contacts and deals
          of the HubSpot account they connect: names, amounts, close dates, pipeline stages and each company&apos;s main contact email. It writes to
          HubSpot only once an owner or admin allows it: then, on each HubSpot deal planned in Vestiarion, what was collected from payments confirmed
          on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion, in a Vestiarion property
          group, never HubSpot&apos;s own fields; and payments on Arc testnet or in shadow mode only to a HubSpot developer test account or sandbox. A
          field someone changed in HubSpot is not written over until a person in Vestiarion chooses to. They are shown to the workspace&apos;s members and to its agent; the agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) may see a deal&apos;s facts to
          decide on its collections, under {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>. Vestiarion never uses HubSpot data to train or improve any AI model, and never passes
          it to anyone else without the workspace&apos;s say. A deal won in HubSpot becomes a deal in Vestiarion only when a person plans it, and a
          change made in HubSpot afterwards changes nothing in Vestiarion until a person does. One HubSpot account connects to one workspace at a
          time. Disconnecting stops the reading at once; the deals already planned stay with the workspace.
        </p>
        <p>
          When an owner or admin connects Pipedrive to a workspace, they agree, for the workspace, that Vestiarion reads the deals of the Pipedrive
          company they connect, with their organizations and persons: titles, values, close dates, pipeline stages, organization names and each
          person&apos;s email, as far as the Pipedrive user who connects can see them. Pipedrive tells Vestiarion when a deal changes, and Vestiarion
          then reads it again from Pipedrive. It writes to Pipedrive only once an owner or admin allows it: then, on each Pipedrive deal planned in
          Vestiarion, what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to
          the deal in Vestiarion, in deal fields Vestiarion creates, never Pipedrive&apos;s own fields. Pipedrive does not say which of its companies
          are developer sandboxes, so only payments made on Arc mainnet outside shadow mode are written to Pipedrive. A field someone changed in Pipedrive
          is not written over until a person in Vestiarion chooses to. They are shown to the workspace&apos;s members and to its agent; the
          agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) may see a deal&apos;s facts to decide on its collections, under{" "}
          {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>. Vestiarion never uses
          Pipedrive data to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. A deal won in
          Pipedrive becomes a deal in Vestiarion only when a person plans it, and a change made in Pipedrive afterwards changes nothing in Vestiarion
          until a person does. One Pipedrive company connects to one workspace at a time. Disconnecting revokes Vestiarion&apos;s access, which, as
          Pipedrive documents it, uninstalls Vestiarion from the company, and stops the reading at once; the deals already planned stay with the workspace.
        </p>
        <p>
          When an owner or admin connects Zoho CRM to a workspace, they agree, for the workspace, that Vestiarion reads the deals of the Zoho CRM
          organization they connect, with their accounts and contacts: deal names, amounts, currencies, closing dates, pipelines and stages, account
          names and each deal&apos;s contact email, and the organization&apos;s name and currency, as far as the Zoho CRM user who connects can see
          them. It writes nothing to Zoho CRM, and the access Zoho grants is read only. They are shown to the workspace&apos;s members and to its
          agent; the agent&apos;s model provider ({HOSTED_MODEL_PROVIDER.name}, on the hosted service) may see a deal&apos;s facts to decide on its
          collections, under {HOSTED_MODEL_PROVIDER.name}&apos;s <LegalLink href={HOSTED_MODEL_PROVIDER.terms}>API terms</LegalLink> and{" "}
          <LegalLink href={HOSTED_MODEL_PROVIDER.privacy}>privacy policy</LegalLink>. Vestiarion never uses Zoho CRM data to train or improve any AI
          model, and never passes it to anyone else without the workspace&apos;s say. A deal won in Zoho CRM becomes a deal in Vestiarion only when
          a person plans it, and a change made in Zoho CRM afterwards changes nothing in Vestiarion until a person does. Several workspaces may
          connect the same organization. Disconnecting, here or in Zoho, stops the reading at once; the deals already planned stay with the
          workspace.
        </p>
        <p>
          When an owner or admin connects Asana to a workspace, they agree, for the workspace, that Vestiarion reads Asana as them: the workspaces,
          projects and tasks a member opens to link a task to a milestone, and for each linked task whether and when it was completed and by whom,
          its assignee, and the links in its description, attachments and comments. Vestiarion makes a webhook on each linked task and deletes it when
          the task is unlinked or Asana is disconnected; it writes nothing else to Asana. A task completed in Asana is never by itself a reason to pay:
          a person in the workspace accepts the work against the milestone&apos;s criteria, an acceptance by a member Vestiarion can tell is the
          payee is refused, and the agent then decides the payment within the workspace&apos;s guardrails. Nothing from Asana sets an amount or a
          payee, and a task reopened or changed after it was accepted is held for review when Vestiarion reads that before the payment is sent;
          keeping anyone else from accepting their own work stays the workspace&apos;s. Vestiarion never uses Asana data to train or improve any AI model, and never
          passes it to anyone else without the workspace&apos;s say. Disconnecting stops the reading at once; acceptances already recorded stay with
          the workspace.
        </p>
      </LegalSection>

      <LegalSection id="the-agent" title="How the agent decides">
        <p>
          The agent&apos;s decisions are automated, within the guardrails your workspace sets. A first payment to a new address, a payment above the
          two-approval figure, and any payment the guardrails hold wait for a person, and some for two. A member who can approve it pays, rejects or returns
          it, and nobody can approve an invoice they created. Every decision is signed into the workspace&apos;s ledger with its reasoning.
        </p>
        <p>
          A workspace on Arc mainnet starts with two approvals above 100 USDC, and an agent spending limit of 50 USDC a day and 150 USDC in 7 days. Both
          can be changed later, but on Arc mainnet two approvals above a figure cannot be turned off, and a daily or 7-day figure always stays.
        </p>
        <p>
          Any member who can approve payments can pause the agent. The service can also stop payments for every workspace on Arc mainnet, or for every
          workspace, while their wallets and USDC stay where they are.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>Do not:</p>
        <ul>
          <li>use hosted wallets or Circle&apos;s faucet for anything but running your workspace, such as collecting testnet USDC, or opening workspaces to hold more hosted wallets;</li>
          <li>use the service to pay or collect money for anything unlawful;</li>
          <li>try to reach another workspace&apos;s data, wallets or keys, or anyone else&apos;s account;</li>
          <li>overload or attack the service, or work around its limits.</li>
        </ul>
        <p>A workspace that breaks these rules may be deleted.</p>
      </LegalSection>

      <LegalSection id="changes" title="Changes">
        <p>The service and these terms can change. When the terms change, the date at the top of this page changes with them.</p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions go to <LegalLink href={ISSUES_URL}>GitHub Issues</LegalLink>. How your data is handled is on the <LegalLink href="/privacy">Privacy</LegalLink>{" "}
          page.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
