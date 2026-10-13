"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { resolveCollectionTaskCommand, setCollectionPolicy } from "@/lib/commands/collections";
import { inOrg } from "@/lib/dal/scope";

/**
 * Collections that follow the customer's context, from Bills & receivables' Receivables tab
 * (docs/superpowers/specs/2026-10-13-collections-context-design.md C4, C6): an owner or admin saves a customer's rules
 * and resolves what the collections stage asked (`records.write`). Through the commands, inside the workspace's scope.
 * An approval, or reminders let go again, starts a cycle, so the reminder goes within a minute through every check.
 */

export interface CollectionActionResult {
  ok: boolean;
  message: string;
}

const NOT_FOUND = "That is not one of this workspace's.";

export async function setCollectionPolicyAction(_previous: CollectionActionResult, formData: FormData): Promise<CollectionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = z.string().uuid().safeParse(formData.get("counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: NOT_FOUND };
  const owner = String(formData.get("accountOwner") ?? "");
  // "owners": nobody named, so the owners and admins are asked.
  const accountOwner = owner === "" || owner === "owners" ? null : z.string().uuid().safeParse(owner).success ? owner : undefined;
  if (accountOwner === undefined) return { ok: false, message: "Choose the account owner from the list." };
  return inOrg(auth, async () =>
    consoleAnswer(
      await setCollectionPolicy(consoleActor(auth), {
        counterpartyId: counterpartyId.data,
        approval: String(formData.get("approval") ?? ""),
        maxTone: String(formData.get("maxTone") ?? ""),
        minDaysBetween: Number(formData.get("minDaysBetween")),
        accountOwner,
        expectedVersion: Number(formData.get("expectedVersion")),
      })
    )
  );
}

export async function resolveCollectionTaskAction(_previous: CollectionActionResult, formData: FormData): Promise<CollectionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const taskId = z.string().uuid().safeParse(formData.get("taskId"));
  if (!taskId.success) return { ok: false, message: NOT_FOUND };
  const tone = formData.get("tone");
  const holdUntil = formData.get("holdUntil");
  return inOrg(auth, async () => {
    const outcome = await resolveCollectionTaskCommand(consoleActor(auth), {
      taskId: taskId.data,
      outcome: String(formData.get("outcome") ?? ""),
      tone: typeof tone === "string" && tone ? tone : null,
      holdUntil: typeof holdUntil === "string" && holdUntil ? holdUntil : null,
    });
    if (outcome.ok && outcome.startsCycle) raiseCycleEvent(auth, "reminder_approved");
    return consoleAnswer(outcome);
  });
}
