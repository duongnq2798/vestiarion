import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/dal", () => ({ platformDb: () => ({}) }));

import { ApprovalCard } from "@/components/growth/GrowthSections";
import { guidedSetupSchema, inboundLead } from "@/lib/growth/guided-setup";
import type { Lead } from "@/lib/growth/read";

/**
 * A guided setup request from /studios in the founder dashboard's approval queue: the card shows who asked, how to
 * reach them, their studio's site and their answers, beside the signal, rather than only the outreach fields an inbound
 * lead leaves empty.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const request = guidedSetupSchema.parse({
  name: "Lan Pham",
  email: "lan@northwind.example",
  studio: "Northwind Studio",
  website: "https://northwind.example",
  contractors: "4-10",
  arrival: "email",
  message: "Six illustrators.",
});

const row = inboundLead(request, { utm_source: "linkedin", utm_campaign: "studios-oct" }, true, "2026-10-10");
const lead = {
  ...row,
  id: "3f1c2a4e-1111-4222-8333-444455556666",
  review_status: "needs_review",
  org_id: null,
  created_at: "2026-10-10T09:00:00Z",
  updated_at: "2026-10-10T09:00:00Z",
} as unknown as Lead;

describe("an inbound lead in the approval queue", () => {
  it("shows who asked, how to reach them, their studio and their answers, from the website form", () => {
    const markup = renderToStaticMarkup(<ApprovalCard lead={lead} />);
    const words = text(markup);
    for (const part of [
      "Northwind Studio",
      "inbound · via website form",
      "Asked for a guided setup on /studios",
      "Contact lan@northwind.example",
      "Name: Lan Pham",
      "Contractors paid a month: 4–10",
      "Invoices arrive by: Email",
      "Message: Six illustrators.",
      "first touch: utm_source=linkedin, utm_campaign=studios-oct",
      "2026-10-10",
    ]) {
      expect(words, part).toContain(part);
    }
    expect(markup).toMatch(/<a [^>]*href="https:\/\/northwind.example"[^>]*rel="noopener noreferrer nofollow"/);
  });
});
