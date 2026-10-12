import type { Metadata } from "next";
import { LegalLink, LegalPage, LegalSection } from "@/components/vx/LegalPage";
import { ISSUES_URL, LICENSE_URL } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Vestiarion: it runs on Arc testnet, it is provided as is, and its code is MIT licensed.",
  alternates: { canonical: "/terms" },
};

/**
 * The terms of use (spec §2, F2). Static and public. Each statement describes
 * what the service does today; `tests/legal-pages.test.tsx` holds the page to
 * its topics.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      updated="2026-10-12"
      intro="These terms cover your use of Vestiarion, an autonomous treasury agent that pays invoices and contractors in USDC and EURC on Arc testnet. By using it, you accept them."
    >
      <LegalSection id="arc-testnet" title="Arc testnet only">
        <p>
          Vestiarion runs on Arc testnet. Its wallets hold testnet USDC, and every payment it makes is a transfer on Arc testnet through Circle
          Developer-Controlled Wallets.
        </p>
      </LegalSection>

      <LegalSection id="the-software" title="The software">
        <p>
          Vestiarion&apos;s code is released under the <LegalLink href={LICENSE_URL}>MIT License</LegalLink>, and its source is public on GitHub. These terms
          cover the hosted service; the license covers the code.
        </p>
      </LegalSection>

      <LegalSection id="as-is" title="Provided as is">
        <p>
          The service is provided as is, without warranty of any kind. It may be unavailable, have bugs, or lose data. As far as the law allows, its
          contributors are not liable for any loss that comes from using it.
        </p>
      </LegalSection>

      <LegalSection id="your-responsibilities" title="Your responsibilities">
        <p>You are responsible for:</p>
        <ul>
          <li>the Circle credentials you connect: they are your own, so keep them safe, and rotate them if they leak;</li>
          <li>your counterparties&apos; wallet addresses: the agent pays the address recorded for a counterparty, and a transfer on chain cannot be taken back;</li>
          <li>your workspace&apos;s guardrails: the payment limits you set decide what the agent may pay on its own, and what it holds for a person;</li>
          <li>who you invite to your workspace, and the role you give them;</li>
          <li>the accounting tool you connect, such as a Xero organisation or a QuickBooks company: connect only one you may give a workspace access to.</li>
        </ul>
      </LegalSection>

      <LegalSection id="accounting-tools" title="Connected accounting tools">
        <p>
          When an owner or admin connects Xero to a workspace, they agree, for the workspace, that Vestiarion reads the bills, suppliers and chart of
          accounts of the Xero organisation they pick. It writes nothing to Xero. The bills a person adds are shown to the workspace&apos;s members and
          to its agent; the agent&apos;s model provider sees each bill&apos;s facts to decide on it, and may not train on them.
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
          agent&apos;s model provider sees each bill&apos;s facts to decide on it, and may not train on them. Vestiarion never uses QuickBooks data, or any
          data from Intuit, to train or improve any AI model, and never passes it to anyone else without the workspace&apos;s say. A bill open in
          QuickBooks is not a payment approved in Vestiarion. Disconnecting, here or in QuickBooks, stops the reading at once; the bills already added
          stay with the workspace.
        </p>
      </LegalSection>

      <LegalSection id="the-agent" title="How the agent decides">
        <p>
          The agent&apos;s decisions are automated, within the guardrails your workspace sets. A payment the guardrails hold waits for a member who can
          approve it to pay, reject or return it, and nobody can approve an invoice they created. Every decision is signed into the workspace&apos;s ledger with
          its reasoning. Any member who can approve payments can also pause the agent.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>Do not:</p>
        <ul>
          <li>use hosted wallets or Circle&apos;s faucet for anything but running your workspace, such as collecting testnet USDC, or opening workspaces to hold more hosted wallets;</li>
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
