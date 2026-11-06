// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRY_HREF } from "@/components/landing/cta";
import { PayQuiz } from "@/components/pay-quiz/PayQuiz";
import { LAB_BILL_AMOUNT, QUIZ_QUESTIONS, QUIZ_URL, quizPostUrl, quizScoreWords, quizShareText } from "@/lib/pay-quiz/questions";
import { QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import { QUALITY_LAB_SCENARIOS } from "@/lib/quality-lab/scenarios";
import { outcomeWords } from "@/lib/quality-lab/words";

/**
 * /would-you-pay (docs/superpowers/specs/2026-11-06-would-you-pay-quiz-design.md WQ1-WQ8): the ten bills held to the
 * Quality Lab scenarios they name and the lab's committed run, the quiz played through in a DOM, its score and share
 * text, and the page around it: static, public, and with nothing that could send an answer anywhere.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/would-you-pay", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("the bills come from the lab (WQ2-WQ4)", () => {
  it("are ten distinct scenarios, five where money moves and five where it stops, mixed", () => {
    const ids = QUIZ_QUESTIONS.map((question) => question.scenarioId);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(QUIZ_QUESTIONS.filter((question) => question.answer === "pay")).toHaveLength(5);
    expect(QUIZ_QUESTIONS.map((question) => question.answer).join(" ")).not.toMatch(/(pay|stop)( \1){2}/);
  });

  it("take the right answer from each scenario's expected money, and the lab's run did the same", () => {
    for (const question of QUIZ_QUESTIONS) {
      const scenario = QUALITY_LAB_SCENARIOS.find((each) => each.id === question.scenarioId)!;
      const result = QUALITY_LAB_RESULTS.scenarios.find((each) => each.id === question.scenarioId)!;
      expect(question.answer, question.scenarioId).toBe(scenario.expected.money === "moves" ? "pay" : "stop");
      expect(result.right, question.scenarioId).toBe(true);
      expect(result.actual.money, question.scenarioId).toBe(scenario.expected.money);
    }
  });

  it("carry the scenario's amount and memo as they are, and a fact the scenario turns on", () => {
    for (const question of QUIZ_QUESTIONS) {
      expect(question.amount, question.scenarioId).toBe(question.scenario.bill?.amount ?? LAB_BILL_AMOUNT);
      expect(question.memo, question.scenarioId).toBe(question.scenario.bill?.memo);
      const facts = Object.fromEntries(question.facts.map((fact) => [fact.label, fact.value]));
      expect(facts["Purchase order"] === "None", question.scenarioId).toBe(question.scenario.bill?.poReference === null);
      expect(facts.Due === "Today", question.scenarioId).toBe(!question.scenario.bill?.dueInDays);
      expect(facts["Pay to"].startsWith("A new address"), question.scenarioId).toBe(Boolean(question.scenario.payee?.addressChanged));
    }
  });
});

describe("the score and what is shared (WQ7, WQ8)", () => {
  const rights = [true, false, true, true, true, true, false, true, true, true];

  it("says the score, a square per bill in order, and the page's address, nothing else", () => {
    expect(quizScoreWords(8, 10)).toBe("You got 8 of 10");
    const [head, squares, url, ...rest] = quizShareText(rights).split("\n");
    expect(head).toBe("Would you pay this bill? I got 8 of 10.");
    expect([...squares].map((square) => square.codePointAt(0))).toEqual(rights.map((each) => (each ? 0x1f7e9 : 0x1f7e5)));
    expect(url).toBe("https://www.vestiarion.xyz/would-you-pay");
    expect(url).toBe(QUIZ_URL);
    expect(rest).toEqual([]);
  });

  it("posts the same text through X's post intent", () => {
    const post = new URL(quizPostUrl(rights));
    expect(`${post.origin}${post.pathname}`).toBe("https://x.com/intent/post");
    expect([...post.searchParams.keys()]).toEqual(["text"]);
    expect(post.searchParams.get("text")).toBe(quizShareText(rights));
  });
});

describe("the quiz, played (WQ5-WQ8)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<PayQuiz />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";
  const buttons = () => [...container.querySelectorAll("button")].map((each) => each.textContent?.trim());

  function click(label: string) {
    const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
    if (!found) throw new Error(`no button ${label}; there are ${buttons().join(", ")}`);
    act(() => found.click());
  }

  it("shows a bill, then after an answer what Vestiarion did and why, with focus on the reveal", () => {
    const first = QUIZ_QUESTIONS[0];
    expect(text()).toContain("Bill 1 of 10");
    expect(text()).toContain(first.vendor);
    expect(text()).toContain("400.00 USDC");
    expect(buttons()).toEqual(["Pay it", "Stop it"]);
    click("Stop it");
    expect(buttons()).toEqual(["Next bill"]);
    const live = container.querySelector('[aria-live="polite"]')!.textContent!.replace(/\s+/g, " ");
    expect(live).toContain("Not this one: you said Stop it.");
    expect(live).toContain(`Vestiarion: ${outcomeWords(first.result.actual)}.`);
    expect(live).toContain(first.why);
    expect(live).toContain(first.scenario.model.reasoning);
    expect(document.activeElement?.textContent).toContain("you said Stop it");
    click("Next bill");
    expect(text()).toContain("Bill 2 of 10");
    expect(document.activeElement?.id).toBe("quiz-bill");
  });

  it("shows the memo verbatim, and says Right for the lab's answer", () => {
    for (const question of QUIZ_QUESTIONS.slice(0, 2)) {
      click(question.answer === "pay" ? "Pay it" : "Stop it");
      click("Next bill");
    }
    const third = QUIZ_QUESTIONS[2];
    expect(third.memo).toBeTruthy();
    expect(text()).toContain(third.memo!);
    click("Pay it");
    expect(text()).toContain("Right: you said Pay it.");
  });

  it("ends with the score, the squares, the lab's own score and the share buttons, and starts over", () => {
    QUIZ_QUESTIONS.forEach((question, index) => {
      // Right on every bill but the last.
      const right = index < QUIZ_QUESTIONS.length - 1;
      click((question.answer === "pay") === right ? "Pay it" : "Stop it");
      click(index === QUIZ_QUESTIONS.length - 1 ? "See your score" : "Next bill");
    });
    expect(document.activeElement?.textContent).toBe("You got 9 of 10");
    const squares = [...container.querySelectorAll('ol[aria-label="Your answers, in order"] li')].map((each) => each.getAttribute("aria-label"));
    expect(squares).toHaveLength(10);
    expect(squares[0]).toBe("Bill 1: right");
    expect(squares[9]).toBe("Bill 10: wrong");
    const lab = QUALITY_LAB_RESULTS.summary;
    expect(text()).toContain(`${lab.right} of ${lab.scenarios} scenarios right, ${lab.wrongPayments} wrong payment`);
    expect(container.querySelector('a[href="/docs/research/quality-lab"]')).not.toBeNull();
    const post = container.querySelector<HTMLAnchorElement>('a[href^="https://x.com/intent/post"]')!;
    expect(post.href).toBe(quizPostUrl([...Array(9).fill(true), false]));
    expect(post.target).toBe("_blank");
    expect(post.rel).toContain("noopener");
    expect(buttons()).toEqual(["Copy result", "Play again"]);
    click("Play again");
    expect(text()).toContain("Bill 1 of 10");
    expect(buttons()).toEqual(["Pay it", "Stop it"]);
  });

  it("copies the share text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    for (const question of QUIZ_QUESTIONS) {
      click(question.answer === "pay" ? "Pay it" : "Stop it");
      click(question === QUIZ_QUESTIONS.at(-1) ? "See your score" : "Next bill");
    }
    await act(async () => {
      [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === "Copy result")!.click();
    });
    expect(writeText).toHaveBeenCalledWith(quizShareText(Array(10).fill(true)));
  });

  it("makes no request and touches no cookie or storage while it is played (WQ8)", () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const opened = vi.spyOn(XMLHttpRequest.prototype, "open");
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const cookie = document.cookie;
    for (const question of QUIZ_QUESTIONS) {
      click(question.answer === "pay" ? "Stop it" : "Pay it");
      click(question === QUIZ_QUESTIONS.at(-1) ? "See your score" : "Next bill");
    }
    expect(text()).toContain("You got 0 of 10");
    expect(fetched).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  });
});

describe("the page (WQ1, WQ8)", () => {
  it("is static and public, with its own title, canonical address, cards and heading, and not under /tools", async () => {
    const page = source("src/app/would-you-pay/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: WouldYouPayPage } = await import("@/app/would-you-pay/page");
    expect(metadata).toMatchObject({
      title: "Would you pay this bill? A two-minute quiz",
      alternates: { canonical: "/would-you-pay" },
      openGraph: { url: "/would-you-pay" },
      twitter: { card: "summary_large_image" },
    });
    const markup = renderToStaticMarkup(<WouldYouPayPage />).replaceAll("&#x27;", "'");
    expect(markup).toMatch(/<h1[^>]*>Would you pay this bill\?<\/h1>/);
    expect(markup).toContain(`href="${TRY_HREF}"`);
    expect(markup).toContain('data-cta="would-you-pay-start"');
    expect(markup).toContain('href="/docs/research/quality-lab"');
    expect(markup).toContain('href="/check-bills"');
    expect(markup).toContain('href="/check-invoice"');
  });

  it("is linked from the Quality Lab page, and watched by the production check (WQ1)", () => {
    expect(source("content/docs/research/quality-lab.mdx")).toContain("(/would-you-pay)");
    const check = source("scripts/synthetic-check.mjs");
    expect(check).toContain('path: "/would-you-pay"');
    expect(check).toContain('"/would-you-pay</loc>"');
  });

  it("sends nothing anywhere: the quiz, its bills and the page make no request, and read or write no address bar, storage or cookie (WQ8)", () => {
    const files = ["src/components/pay-quiz/PayQuiz.tsx", "src/lib/pay-quiz/questions.ts", "src/app/would-you-pay/page.tsx"];
    for (const file of files) {
      expect(source(file), file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|useParams|URLSearchParams|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/,
      );
      expect(source(file), file).not.toMatch(/\bVND\b|\b(?:safe|cleared|verified|compliant)\b/);
    }
    // The one link built from the answers is X's post intent, which carries only the share text.
    expect(source("src/components/pay-quiz/PayQuiz.tsx").match(/href=\{[^}]*\}/g)).toEqual(["href={quizPostUrl(rights)}"]);
    expect(source("src/app/would-you-pay/page.tsx")).not.toContain("data-cta");
    for (const file of files.filter((each) => !each.startsWith("src/app/"))) expect(source(file), file).not.toMatch(/ToolCta|ToolStartLink|free-tools/);
  });
});
