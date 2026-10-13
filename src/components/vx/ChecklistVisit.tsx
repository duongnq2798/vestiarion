"use client";

import { useEffect, useRef } from "react";
import { recordAccountantVisitAction, recordApprovalsVisitAction } from "@/app/actions/onboarding";

/**
 * Records what opening this page did for the person's checklist (docs/superpowers/specs/2026-10-13-role-onboarding-
 * evidence-access-design.md R2, R3): Approvals opened as an approver, or the accountant console and the queue it is
 * narrowed to. Sent once the page is in the browser, never while it renders on the server: Next.js forbids a mutation
 * there, and a prefetch could tick a step for a page nobody opened. The page renders this only while a mark is missing,
 * with the workspaces, by slug, that miss it; each action checks the session's membership and role there again. `queue`
 * is the workspace the accountant console is narrowed to, if any. Renders nothing.
 */
export function ChecklistVisit({ page, slugs, queue = null }: { page: "approvals" | "accountant"; slugs: readonly string[]; queue?: string | null }) {
  const sent = useRef<string | null>(null);
  const key = [page, queue ?? "", ...slugs].join(" ");
  useEffect(() => {
    if (sent.current === key) return;
    sent.current = key;
    const [kind, narrowed, ...workspaces] = key.split(" ");
    for (const slug of workspaces) {
      const recorded = kind === "approvals" ? recordApprovalsVisitAction(slug) : recordAccountantVisitAction(slug, narrowed || null);
      recorded.catch(() => {});
    }
  }, [key]);
  return null;
}
