import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Start the live slice on the report (docs/superpowers/specs/2026-10-18-live-slice-design.md L1, L3, L5): the vendors an
 * owner may carry, each saying how its address goes over, a vendor with no limit not offered; the report's last step,
 * which names the slice and ticks once it is live.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/live-slice", () => ({ startLiveSliceAction: vi.fn() }));

const { LiveSliceStart } = await import("@/components/vx/LiveSliceStart");
const { ReportReadiness } = await import("@/components/vx/WorkspaceReport");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

const vendors = [
  { id: "a", name: "Cobalt Cloud", address: "own" as const, paymentLimit: 200 },
  { id: "b", name: "Lumen Print Co.", address: "mirror" as const, paymentLimit: 50 },
  { id: "c", name: "Taller Norte", address: "none" as const, paymentLimit: null },
];

describe("LiveSliceStart", () => {
  it("offers an owner the vendors with how each address goes over, and none without a limit", () => {
    const html = renderToStaticMarkup(<LiveSliceStart orgSlug="acme-shadow" vendors={vendors} canStart />);
    const words = text(html);
    expect(words).toContain("Start the live slice");
    expect(words).toContain("Cobalt Cloud Limit 200 USDC Its own address, confirmed again there");
    expect(words).toContain("Lumen Print Co. Limit 50 USDC Mirror address: it adds its own there");
    expect(words).toContain("Taller Norte No payment limit: set one on Counterparties to carry it");
    expect(words).toContain("Pay in USDC only where that is lawful for your business, and with a vendor that accepts USDC on Arc.");
    expect(words).toContain("Open the live slice on Arc mainnet");
    // Taller Norte's box is off.
    expect(html).toMatch(/id="slice-vendor-c" type="checkbox" disabled=""/);
  });

  it("tells anyone else that an owner starts it", () => {
    const words = text(renderToStaticMarkup(<LiveSliceStart orgSlug="acme-shadow" vendors={vendors} canStart={false} />));
    expect(words).toContain("An owner can start the live slice.");
    expect(words).not.toContain("Open the live slice on Arc mainnet");
  });
});

describe("ReportReadiness with a live slice", () => {
  const steps = [
    { key: "verdicts" as const, done: true, given: 9, target: 5 },
    { key: "waiting" as const, done: true, waiting: 0 },
    { key: "addresses" as const, done: false, mirrorPayees: 1 },
    { key: "mainnet" as const, done: null },
  ];

  it("names the slice and its next step until it is live, then ticks it", () => {
    const opened = { name: "Acme live slice", slug: "acme-live-slice", opened: "Oct 18, 2026", vendors: 2, live: false };
    const waiting = text(renderToStaticMarkup(<ReportReadiness steps={steps} slice={opened} />));
    expect(waiting).toContain("2 of 4 done");
    expect(waiting).toContain("Go live with Acme live slice");
    expect(waiting).toContain("Opened on Oct 18, 2026 with 2 vendors. Go live from its Settings");
    expect(waiting).toContain("Open Acme live slice");

    const live = text(renderToStaticMarkup(<ReportReadiness steps={steps} slice={{ ...opened, live: true }} />));
    expect(live).toContain("3 of 4 done");
    expect(live).toContain("Live slice on Arc mainnet: Acme live slice");
  });

  it("before a slice, says Start the live slice opens it, and does not count the step", () => {
    const before = text(renderToStaticMarkup(<ReportReadiness steps={steps} />));
    expect(before).toContain("2 of 3 done");
    expect(before).toContain("Start the live slice, below, opens it with them.");
  });
});
