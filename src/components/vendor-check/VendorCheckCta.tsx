import { ToolCta } from "@/components/public/ToolCta";

/**
 * The vendor check's call to action (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV9): what Vestiarion
 * does before it pays, the free tools' shared **Try it on your bills** (`ToolCta`, named `check-vendor-start`, which
 * credits a workspace opened after it to this tool: free tool attribution TA3), and the shadow-mode line. What it says
 * of the product is what the product's code does (guardrails `counterparty.unscreened` and `counterparty.high_risk`,
 * the approval's `high_risk` refusal); this page's own score plays no part in it. `ToolCta` lives apart from the
 * checker's files, whose code touches no cookie.
 */
export function VendorCheckCta() {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-ink-2">
        Vestiarion screens every vendor and checks every pay-to wallet against OFAC&apos;s list. The agent pays no vendor until screening gives a
        verdict, and no one can pay a vendor screened high risk.
      </p>
      <ToolCta tool="check-vendor" />
      <p className="text-sm leading-relaxed text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
    </div>
  );
}
