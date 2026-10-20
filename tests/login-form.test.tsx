import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LoginForm from "@/components/auth/LoginForm";

vi.mock("@/app/login/actions", () => ({ signInWithEmail: vi.fn() }));

/**
 * The sign-in card's form, rendered to static markup: the message's live region is in the page from the start, so a
 * screen reader announces the first message, but while it is empty it is visually hidden and takes no gap, so the
 * card ends at its button.
 */
describe("LoginForm", () => {
  const html = renderToStaticMarkup(<LoginForm next="/" />);

  it("keeps an empty live region for the first message", () => {
    expect(html).toMatch(/<p role="status" aria-live="polite" class="[^"]*empty:sr-only[^"]*"><\/p>/);
  });

  it("spaces its fields with a flex gap, which a hidden region does not take", () => {
    expect(html).toMatch(/<form[^>]*class="flex flex-col gap-4"/);
    expect(html).not.toContain("space-y-4");
  });

  it("asks for a work email and sends a link", () => {
    expect(html).toContain("Work email");
    expect(html).toContain("Email me a sign-in link");
  });
});
