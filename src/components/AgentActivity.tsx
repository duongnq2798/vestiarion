"use client";

import { Clock, LoaderCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toaster";
import { AGENT_EXPECTED_EVENT, EXPECT_AGENT_MS, nextPollMs, TOLD_ONE_BY_ONE, workingLabel, type ActivityItem } from "@/lib/agent-activity";
import { isValidSlug, orgHref } from "@/lib/auth/org-paths";
import { utcMinute } from "@/lib/copy";
import { arcTxUrl } from "@/lib/payee-chains";

/** The route's answer (src/app/api/agent/activity/route.ts). */
interface ActivityAnswer {
  running: { startedAt: string } | null;
  head: number;
  lastCycleAt: string | null;
  items: ActivityItem[];
}

/**
 * The agent's state in the page's frame, kept current while the page is open (agent activity spec R1–R4): when the
 * last cycle ran, while it waits; "The agent is working · 12 s" while a cycle runs; and once it has decided, a toast
 * for each decision — what it did, its Arc testnet transaction, and the page to see or handle it — with the page read
 * again at once. It asks every 3 s while a cycle runs or a person's action has just given it work, every 20 s
 * otherwise, and not while the tab is hidden. A page has seen everything up to the ledger's head when it opens: only
 * what happens after is told.
 */
export function AgentActivity({ lastCycleAt: initialLastCycleAt }: { lastCycleAt: string | null }) {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" && isValidSlug(params.slug) ? params.slug : null;
  const router = useRouter();
  const [running, setRunning] = useState<{ startedAt: string } | null>(null);
  const [lastCycleAt, setLastCycleAt] = useState(initialLastCycleAt);
  const [now, setNow] = useState(() => Date.now());
  const cursor = useRef<number | null>(null);
  const expectingUntil = useRef(0);

  useEffect(() => {
    if (!slug) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let wasRunning = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(poll, delay);
    };

    async function poll() {
      // A hidden tab asks nothing; showing it again asks at once.
      if (document.visibilityState === "hidden") return;
      try {
        const since = cursor.current;
        const query = since === null ? "" : `&since=${since}`;
        const response = await fetch(`/api/agent/activity?org=${encodeURIComponent(slug as string)}${query}`, { cache: "no-store" });
        if (response.ok) {
          const answer = (await response.json()) as ActivityAnswer;
          if (stopped) return;
          setRunning(answer.running);
          setLastCycleAt(answer.lastCycleAt);
          if (since !== null && answer.items.length > 0) {
            tell(answer.items, since, (path) => router.push(orgHref(slug as string, path)));
          }
          // A cycle starting (its payables read "Deciding now"), one finished, or anything new, is shown on the page
          // at once rather than at its next refresh.
          const started = since !== null && !wasRunning && answer.running !== null;
          const finished = wasRunning && answer.running === null;
          if (started || finished || answer.items.length > 0) router.refresh();
          wasRunning = answer.running !== null;
          cursor.current = Math.max(since ?? 0, answer.head, ...answer.items.map((item) => item.seq));
        }
      } catch {
        // Asked again at the next interval.
      }
      schedule(nextPollMs({ running: wasRunning, expectingUntil: expectingUntil.current, now: Date.now() }));
    }

    // A person's action has just given the agent work: watch closely for a while.
    const expect = () => {
      expectingUntil.current = Date.now() + EXPECT_AGENT_MS;
      schedule(1_500);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule(0);
    };

    window.addEventListener(AGENT_EXPECTED_EVENT, expect);
    document.addEventListener("visibilitychange", onVisibility);
    schedule(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener(AGENT_EXPECTED_EVENT, expect);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [slug, router]);

  // The seconds count while a cycle runs.
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [running]);

  return (
    <span aria-live="polite" className="inline-flex items-center gap-1.5">
      {running ? (
        <>
          <LoaderCircle aria-hidden className="size-3.5 text-agent motion-safe:animate-spin" />
          <span className="font-medium text-agent">{workingLabel(running.startedAt, now)}</span>
        </>
      ) : (
        <>
          <Clock aria-hidden className="size-3.5" />
          {lastCycleAt ? `Last cycle ${utcMinute(lastCycleAt)}` : "No cycle recorded yet"}
        </>
      )}
    </span>
  );
}

/**
 * A toast's words and what to do: why, then the button and the transaction under it, so the words take the toast's
 * whole width rather than a column beside a button (the partner's test: a stop's reason wrapped in a narrow column).
 */
export function ActivityToastBody({
  detail,
  action,
  txHash,
  primary,
  onAction,
}: {
  detail: string | null;
  action: string;
  txHash: string | null;
  /** The person's next step (a stop) is the toast's main button; a look at what happened is a quiet one. */
  primary: boolean;
  onAction: () => void;
}) {
  return (
    <span className="mt-1 grid gap-2.5">
      {detail && <span>{detail}</span>}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={onAction}>
          {action}
        </Button>
        {txHash && (
          <a href={arcTxUrl(txHash)} target="_blank" rel="noreferrer" className="text-xs font-medium text-agent underline-offset-2 hover:underline">
            View on Arcscan
          </a>
        )}
      </span>
    </span>
  );
}

/** The toasts for what the agent decided: one each for a few, one for many, which opens the cycle's report. */
function tell(items: ActivityItem[], since: number, go: (path: string) => void) {
  if (items.length > TOLD_ONE_BY_ONE) {
    const id = `agent-activity-${since}`;
    const waiting = items.filter((item) => item.tone === "stopped").length;
    toast.info(`The agent made ${items.length} decisions.`, {
      id,
      description: (
        <ActivityToastBody
          detail={waiting > 0 ? `${waiting} of them ${waiting === 1 ? "waits" : "wait"} for you.` : null}
          action="See them"
          txHash={null}
          primary={waiting > 0}
          onAction={() => {
            toast.dismiss(id);
            go(`/console?since=${since}`);
          }}
        />
      ),
    });
    return;
  }
  for (const item of items) {
    const id = `agent-activity-${item.seq}`;
    const raise = item.tone === "done" ? toast.success : toast.warning;
    raise(item.text, {
      id,
      description: (
        <ActivityToastBody
          detail={item.detail}
          action={item.pathLabel}
          txHash={item.txHash}
          primary={item.tone === "stopped"}
          onAction={() => {
            toast.dismiss(id);
            go(item.path);
          }}
        />
      ),
      // Long enough to read and act on; a stop waits longer, since it waits for the person.
      duration: item.tone === "done" ? 8_000 : 12_000,
    });
  }
}
