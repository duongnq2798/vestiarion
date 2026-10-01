import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The console's "Scheduled payments" section (payment timing, 2026-09-30) is
 * derived from the invoices the page already loads with `listInvoices()` —
 * no new query — and hidden when there is nothing scheduled. Checked as
 * source, the way `tests/control-ui.test.tsx` checks the rest of the
 * console's wiring: the page is an async server component reading from
 * Supabase, not something `renderToStaticMarkup` can render directly.
 */

const CONSOLE_PAGE = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/console/page.tsx"), "utf8");

describe("the console's Scheduled payments section, as source", () => {
  it("derives it from the invoices already loaded, not a new query", () => {
    expect(CONSOLE_PAGE).toMatch(/scheduledPaymentRows\(invoices\)/);
  });

  it("renders the section only when something is scheduled", () => {
    expect(CONSOLE_PAGE).toMatch(/\{scheduled\w*\.length > 0 && \(?\s*<ScheduledPayments/);
  });

  it("imports ScheduledPayments and scheduledPaymentRows from the vx component", () => {
    expect(CONSOLE_PAGE).toMatch(/import \{ ScheduledPayments, scheduledPaymentRows \} from "@\/components\/vx\/ScheduledPayments";/);
  });
});
