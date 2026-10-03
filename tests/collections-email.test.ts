import { describe, expect, it } from "vitest";
import { receivableReminderEmail } from "@/lib/email/receivable-reminder";

/** The reminder a client gets (docs/superpowers/specs/2026-10-03-collections-design.md R6): a template by tone. */

const base = {
  orgName: "Mai Studio",
  clientName: "Acme",
  amount: "12.50",
  token: "USDC",
  what: "October retainer",
  dueOn: "Oct 10, 2026",
  payUrl: "https://www.vestiarion.xyz/pay/vxr_abc",
  origin: "https://www.vestiarion.xyz",
};

describe("the reminder email", () => {
  it("asks kindly before the due date, on it, and just after it", () => {
    const before = receivableReminderEmail({ ...base, daysFromDue: -3, tone: "friendly" });
    expect(before.subject).toBe("Mai Studio: 12.50 USDC due Oct 10, 2026");
    expect(before.text).toContain("Mai Studio asked you to pay 12.50 USDC for October retainer, due Oct 10, 2026, in 3 days.");
    expect(receivableReminderEmail({ ...base, daysFromDue: 0, tone: "friendly" }).subject).toBe("Mai Studio: 12.50 USDC due today");
    expect(receivableReminderEmail({ ...base, daysFromDue: 1, tone: "friendly" }).text).toContain("which was due Oct 10, 2026, 1 day ago.");
  });

  it("is firm once it is late, and says the last one is the last", () => {
    const firm = receivableReminderEmail({ ...base, daysFromDue: 4, tone: "firm" });
    expect(firm.subject).toBe("Reminder: 12.50 USDC to Mai Studio was due Oct 10, 2026");
    expect(firm.text).toContain("Your payment of 12.50 USDC to Mai Studio for October retainer was due Oct 10, 2026, 4 days ago, and has not arrived.");
    const final = receivableReminderEmail({ ...base, daysFromDue: 10, tone: "final" });
    expect(final.subject).toBe("Final reminder: 12.50 USDC to Mai Studio, due Oct 10, 2026");
    expect(final.text).toContain("This is the last reminder Vestiarion sends for it. After this, Mai Studio follows up with you directly.");
  });

  it("carries the pay link, says who asked for it, and escapes what the workspace typed", () => {
    const email = receivableReminderEmail({ ...base, orgName: "Mai <Studio>", what: null, daysFromDue: 0, tone: "friendly" });
    expect(email.html).toContain('href="https://www.vestiarion.xyz/pay/vxr_abc"');
    expect(email.html).toContain("Pay on Arc testnet");
    expect(email.html).toContain("Mai &lt;Studio&gt;");
    expect(email.html).not.toContain("Mai <Studio>");
    expect(email.text).toContain("asked its agent to remind you");
    expect(email.text).toContain("Pay on Arc testnet: https://www.vestiarion.xyz/pay/vxr_abc");
  });
});
