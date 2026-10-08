import Link from "next/link";
import { Verdict, type EvidenceTone } from "@/components/landing/evidence/Evidence";

const REPOSITORY = "https://github.com/duongnq2798/vestiarion";

function Credential({
  badge,
  body,
  href,
  label,
  tone,
}: {
  badge: string;
  body: string;
  href: string;
  label: string;
  tone: EvidenceTone;
}) {
  const external = href.startsWith("https://");

  return (
    <Link
      href={href}
      className="group min-w-0 border-line px-3 py-4 first:pl-0 even:border-l min-[440px]:px-5 lg:border-l lg:first:border-l-0 lg:first:pl-0"
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <Verdict tone={tone}>{badge}</Verdict>
      <h4 className="mt-3 text-[0.9375rem] font-semibold leading-snug text-ink">{label}</h4>
      <p className="mt-1 text-xs leading-relaxed text-ink-2">{body}</p>
      <span className="mt-2 inline-block font-mono text-xs font-semibold text-agent group-hover:underline">
        Check it {external ? "↗" : "→"}
      </span>
    </Link>
  );
}

/**
 * Four claims a reader can check at their source, each a link to it: the payment rail, screening, the evidence chain
 * and the licence. Drawn at the head of "Claims with receipts" (docs/superpowers/specs/2026-10-08-landing-motion-design.md
 * M3), so the page has one claims section.
 */
export function CredentialChecks({ screeningMode }: { screeningMode: "live" | "simulate" }) {
  const screeningIsLive = screeningMode === "live";

  return (
    <div className="rounded-2xl border border-line bg-surface/80">
      <div className="flex flex-col gap-1 border-b border-line px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:px-5">
        <h3 className="font-serif text-xl text-ink">Verifiable, not vouched for.</h3>
        <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-3">Four claims you can check</p>
      </div>
      <div className="grid grid-cols-2 px-4 sm:px-5 lg:grid-cols-4">
        <Credential
          badge="Arc"
          body="Circle Developer-Controlled Wallets route the live USDC payment path."
          href={`${REPOSITORY}/blob/main/src/lib/circle/liveProvider.ts`}
          label="Circle payment rail"
          tone="agent"
        />
        <Credential
          badge={screeningIsLive ? "Live" : "Bundled list"}
          body={
            screeningIsLive
              ? "This deployment calls the configured OpenSanctions match endpoint."
              : "This deployment labels and uses the small bundled screening list."
          }
          href={`${REPOSITORY}/blob/main/src/lib/compliance.ts`}
          label="Counterparty screening"
          tone={screeningIsLive ? "proof" : "held"}
        />
        <Credential
          badge="Signed"
          body="Ed25519 entries link to the previous SHA-256 hash; members can run the verifier."
          href="/onboarding"
          label="Evidence chain"
          tone="proof"
        />
        <Credential
          badge="MIT"
          body="The implementation and license are public in the Vestiarion repository."
          href={`${REPOSITORY}/blob/main/LICENSE`}
          label="Open source"
          tone="proof"
        />
      </div>
    </div>
  );
}
