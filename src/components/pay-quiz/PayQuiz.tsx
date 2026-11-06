"use client";

import { ExternalLink, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { QUIZ_QUESTIONS, quizPostUrl, quizScoreWords, quizShareText, type QuizAnswer, type QuizQuestion } from "@/lib/pay-quiz/questions";
import { QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import { outcomeWords, scoreWords, wrongPaymentWords } from "@/lib/quality-lab/words";

const ANSWER_WORDS: Record<QuizAnswer, string> = { pay: "Pay it", stop: "Stop it" };

function usdc(amount: number): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

/** The bill as a person would see it (WQ4). */
function BillCard({ question }: { question: QuizQuestion }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-5 py-5 shadow-control sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base font-semibold text-ink">{question.vendor}</p>
        <p className="font-mono text-base font-semibold tabular-nums text-ink">{usdc(question.amount)}</p>
      </div>
      <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
        {question.facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-ink-3">{fact.label}</dt>
            <dd className="text-ink">{fact.value}</dd>
          </div>
        ))}
        {question.memo ? (
          <div className="contents">
            <dt className="text-ink-3">Memo</dt>
            <dd className="rounded-lg bg-raised px-3 py-2 text-ink [overflow-wrap:anywhere]">{question.memo}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/** After an answer (WQ6): whether it was right, what Vestiarion did in the lab's own words, what the model said, and why. */
function Reveal({ question, given, last, onNext }: { question: QuizQuestion; given: QuizAnswer; last: boolean; onNext: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const right = given === question.answer;
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className={`mt-5 rounded-2xl border px-5 py-5 sm:px-6 ${right ? "border-proof-line bg-proof-soft" : "border-refused-line bg-refused-soft"}`}>
      <h3 ref={heading} tabIndex={-1} className={`text-base font-semibold outline-none ${right ? "text-proof" : "text-refused"}`}>
        {right ? "Right" : "Not this one"}: you said {ANSWER_WORDS[given]}.
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-ink">
        <span className="font-medium">Vestiarion:</span> {outcomeWords(question.result.actual)}.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{question.why}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-3">
        The model in this case was scripted to answer &ldquo;{question.scenario.model.reasoning}&rdquo;
      </p>
      <div className="mt-4">
        <Button onClick={onNext}>{last ? "See your score" : "Next bill"}</Button>
      </div>
    </div>
  );
}

/** The end (WQ7): the score, the squares, the lab's own score, and the ways to share it. */
function Score({ rights, onAgain }: { rights: boolean[]; onAgain: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const right = rights.filter(Boolean).length;
  const lab = QUALITY_LAB_RESULTS.summary;
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-[-0.01em] text-ink outline-none">
        {quizScoreWords(right, rights.length)}
      </h2>
      <ol aria-label="Your answers, in order" className="mt-3 flex flex-wrap gap-1.5">
        {rights.map((each, index) => (
          <li
            key={index}
            aria-label={`Bill ${index + 1}: ${each ? "right" : "wrong"}`}
            className={`size-6 rounded-md ${each ? "bg-proof" : "bg-refused"}`}
          />
        ))}
      </ol>
      <p className="mt-4 text-sm leading-relaxed text-ink-2">
        Vestiarion&apos;s code, on every case in its{" "}
        <Link href="/docs/research/quality-lab" className="font-medium text-agent underline underline-offset-4">
          Quality Lab
        </Link>
        : {scoreWords(lab)}, {wrongPaymentWords(lab.wrongPayments)}. These ten bills are ten of them.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <CopyButton value={quizShareText(rights)} variant="secondary" size="md" label="Copy result">
          Copy result
        </CopyButton>
        <Button asChild variant="secondary">
          <a href={quizPostUrl(rights)} target="_blank" rel="noopener noreferrer">
            Post on X
            <ExternalLink aria-hidden />
          </a>
        </Button>
        <Button variant="ghost" icon={<RotateCcw />} onClick={onAgain}>
          Play again
        </Button>
      </div>
    </div>
  );
}

/**
 * /would-you-pay's quiz (docs/superpowers/specs/2026-11-06-would-you-pay-quiz-design.md WQ4-WQ8): ten bills, each
 * answered Pay it or Stop it, then shown with what Vestiarion did, and a score at the end to copy or post. The answers
 * stay in this component's state: nothing is sent or stored.
 */
export function PayQuiz({ questions = QUIZ_QUESTIONS }: { questions?: ReadonlyArray<QuizQuestion> }) {
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [index, setIndex] = useState(0);
  const prompt = useRef<HTMLHeadingElement>(null);
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    if (moved) prompt.current?.focus();
  }, [index, moved]);

  if (index >= questions.length) {
    const rights = questions.map((question, at) => answers[at] === question.answer);
    return (
      <Score
        rights={rights}
        onAgain={() => {
          setAnswers([]);
          setIndex(0);
          setMoved(true);
        }}
      />
    );
  }

  const question = questions[index];
  const given = answers[index];
  const next = () => {
    setIndex(index + 1);
    setMoved(true);
  };

  return (
    <section aria-labelledby="quiz-bill">
      <h2 id="quiz-bill" ref={prompt} tabIndex={-1} className="text-lg font-semibold tracking-[-0.01em] text-ink outline-none">
        Bill {index + 1} of {questions.length}
      </h2>
      <div className="mt-4">
        <BillCard question={question} />
      </div>
      {given ? null : (
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => setAnswers([...answers.slice(0, index), "pay"])}>{ANSWER_WORDS.pay}</Button>
          <Button variant="secondary" onClick={() => setAnswers([...answers.slice(0, index), "stop"])}>
            {ANSWER_WORDS.stop}
          </Button>
        </div>
      )}
      <div aria-live="polite">{given ? <Reveal key={index} question={question} given={given} last={index === questions.length - 1} onNext={next} /> : null}</div>
    </section>
  );
}
