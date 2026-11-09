"use client";

import { CircleCheck, ExternalLink, Link2, ListChecks, RefreshCw, SquareKanban, Unlink } from "lucide-react";
import { useId } from "react";
import { acceptJiraWorkAction, checkJiraIssueAction, linkJiraIssueAction, setJiraCriteriaAction, unlinkJiraIssueAction, type JiraActionResult } from "@/app/actions/jira";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { JiraDeliverableView, JiraMilestoneView, JiraTone } from "@/lib/jira/views";

/**
 * A milestone's Jira card on Contractors (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR6, JR7, JR11,
 * JR13, JR22), as Linear's (`LinearIssueCard`): link the Jira issue its work is delivered in, by pasting the issue's link
 * or its key; write the acceptance criteria from the agreement; and, once the issue is done, accept the work against the
 * criteria, as the deliverables shown. Jira has no picker: an issue is named by its link or its key alone. Every control
 * posts to a server action that reads the person's role again; the view carries words and links only. Beside Jira's
 * name is the product's icon for work tools: no Atlassian logo is shipped.
 */

const INITIAL: JiraActionResult = { ok: false, message: "" };

const TONES: Record<JiraTone, "neutral" | "agent" | "proof" | "held"> = { waiting: "neutral", ready: "agent", accepted: "proof", held: "held" };
const KIND_WORDS: Record<JiraDeliverableView["kind"], string> = {
  file: "Attachment",
  web_link: "Web link",
  link: "Link in the description",
  comment_link: "Link in a comment",
};

function Message({ state }: { state: JiraActionResult }) {
  return (
    <FormMessage tone={state.message && !state.ok ? "error" : "neutral"} className="text-xs">
      {state.ok ? null : state.message}
    </FormMessage>
  );
}

function Hidden({ orgSlug, milestoneId }: { orgSlug: string; milestoneId: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
    </>
  );
}

function CriteriaForm({ orgSlug, milestoneId, criteria }: { orgSlug: string; milestoneId: string; criteria: string | null }) {
  const { state, formProps } = useActionForm(setJiraCriteriaAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        Acceptance criteria, from the agreement
      </label>
      <Textarea id={id} name="criteria" required minLength={3} maxLength={2000} rows={3} defaultValue={criteria ?? ""} placeholder="What the work must be to be accepted: format, scope, count, deadline." />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" icon={<ListChecks aria-hidden />}>
          {criteria ? "Save the criteria" : "Add the criteria"}
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

/** The issue's link or its key (JR6): read for the site's host and the key alone, never opened. */
function LinkIssue({ orgSlug, milestoneId }: { orgSlug: string; milestoneId: string }) {
  const { state, formProps } = useActionForm(linkJiraIssueAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        The Jira issue the work is delivered in
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={id}
          name="issue"
          type="text"
          required
          size="sm"
          placeholder="https://your-site.atlassian.net/browse/ENG-123 or ENG-123"
          className="h-11 sm:h-8"
          maxLength={1000}
          autoComplete="off"
          spellCheck={false}
        />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Linking…" className="h-11 shrink-0 sm:h-8" icon={<Link2 aria-hidden />}>
          Link the issue
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">Paste the issue&apos;s link or its key. Vestiarion reads the issue through Jira with this workspace&apos;s connection, never by opening the link.</p>
      <Message state={state} />
    </form>
  );
}

function Deliverables({ items }: { items: JiraDeliverableView[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">No attachment or web link, and no link in the description or the comments.</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={`${item.kind}-${item.label}-${item.href ?? ""}`} className="min-w-0 text-sm">
          <span className="text-xs text-ink-3">{KIND_WORDS[item.kind]}: </span>
          {item.href ? (
            <a href={item.href} target="_blank" rel="noreferrer nofollow ugc" className="break-words font-medium text-agent underline-offset-4 hover:underline">
              {item.label}
              <ExternalLink aria-hidden className="ml-1 inline size-3" />
              <span className="sr-only"> (opens in a new tab{item.given ? ", not checked by Vestiarion" : ""})</span>
            </a>
          ) : (
            <span className="break-words text-ink-2">{item.label}</span>
          )}
          {item.note && <span className="block text-xs text-held">{item.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function Accept({ orgSlug, milestoneId, fingerprint, criteriaSha256 }: { orgSlug: string; milestoneId: string; fingerprint: string; criteriaSha256: string }) {
  const { state, formProps } = useActionForm(acceptJiraWorkAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2 rounded-lg border border-agent-line bg-agent-soft p-3">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <input type="hidden" name="criteriaSha256" value={criteriaSha256} />
      <Checkbox id={id} name="confirmed" value="yes" required label="I checked each criterion against these deliverables, as shown here." />
      <p className="text-xs text-ink-2">Accepting verifies the milestone. The agent then decides on pay under every guardrail; nothing from Jira sets the amount or the payee.</p>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Accepting…" icon={<CircleCheck aria-hidden />}>
          Accept the work
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

function SmallAction({
  orgSlug,
  milestoneId,
  action,
  label,
  pending,
  icon,
}: {
  orgSlug: string;
  milestoneId: string;
  action: (previous: JiraActionResult, data: FormData) => Promise<JiraActionResult>;
  label: string;
  pending: string;
  icon: React.ReactNode;
}) {
  const { state, formProps } = useActionForm(action, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel={pending} icon={icon}>
        {label}
      </SubmitButton>
      <Message state={state} />
    </form>
  );
}

/**
 * `withCriteria` false leaves the criteria field out of a card that offers to link an issue, where the card above,
 * `criteriaIn`'s (Asana's or Linear's), asks for the same milestone's criteria (`workToolCards`): they are asked once.
 */
export function JiraIssueCard({
  orgSlug,
  milestoneId,
  view,
  withCriteria = true,
  criteriaIn = "Asana",
}: {
  orgSlug: string;
  milestoneId: string;
  view: JiraMilestoneView;
  withCriteria?: boolean;
  criteriaIn?: "Asana" | "Linear";
}) {
  if (!view.linked) {
    if (!view.canWrite) return null;
    return (
      <div className="mt-2 space-y-3 rounded-xl border border-line bg-ground/40 p-3" data-jira-state="unlinked">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <SquareKanban aria-hidden className="size-4 shrink-0 text-ink-2" />
          Accept from Jira
        </p>
        {view.connected ? (
          <>
            <p className="text-sm text-ink-2">
              Link the issue the contractor delivers in. Once it is done in Jira, you accept the work against its criteria; an issue marked done alone never
              pays.
            </p>
            <LinkIssue orgSlug={orgSlug} milestoneId={milestoneId} />
            {withCriteria ? (
              <CriteriaForm orgSlug={orgSlug} milestoneId={milestoneId} criteria={view.criteria} />
            ) : (
              <p className="text-xs text-ink-3">
                The acceptance criteria are the milestone&apos;s, written once under Accept from {criteriaIn}: the work is held to them in Jira too.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-3">Connect Jira in Settings, Integrations, to accept this work from a Jira issue.</p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-3 rounded-xl border border-line bg-ground/40 p-3" data-jira-state={view.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-start gap-2 text-sm font-semibold text-ink">
          <SquareKanban aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
          <span className="min-w-0">
            <span className="text-ink-3">Jira issue {view.identifier}: </span>
            {view.issueUrl ? (
              <a href={view.issueUrl} target="_blank" rel="noreferrer" className="break-words text-agent underline-offset-4 hover:underline">
                {view.issueTitle}
                <span className="sr-only"> (opens Jira in a new tab)</span>
              </a>
            ) : (
              <span className="break-words">{view.issueTitle}</span>
            )}
          </span>
        </p>
        <Badge size="sm" tone={TONES[view.tone]} dot>
          {view.label}
        </Badge>
      </div>
      <p className="text-sm text-ink-2">{view.line}</p>
      <ul className="space-y-0.5 text-xs text-ink-3">
        {view.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {view.readError && (
        <p role="status" className="text-xs text-held">
          {view.readError}
        </p>
      )}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-ink">{view.state === "accepted" ? "Deliverables accepted" : "Deliverables in Jira"}</p>
        <Deliverables items={view.deliverables} />
      </div>
      <div className="space-y-1.5">
        {view.canWrite && view.canEditCriteria ? (
          <CriteriaForm orgSlug={orgSlug} milestoneId={milestoneId} criteria={view.criteria} />
        ) : (
          <>
            <p className="text-xs font-semibold text-ink">Acceptance criteria</p>
            <p className="whitespace-pre-line text-sm text-ink-2">{view.criteria ?? "None written yet."}</p>
          </>
        )}
      </div>
      {view.canWrite && view.canAccept && view.fingerprint && view.criteriaSha256 && (
        <Accept orgSlug={orgSlug} milestoneId={milestoneId} fingerprint={view.fingerprint} criteriaSha256={view.criteriaSha256} />
      )}
      {view.canWrite && (
        <div className="flex flex-wrap items-start gap-3 border-t border-line pt-3">
          <SmallAction orgSlug={orgSlug} milestoneId={milestoneId} action={checkJiraIssueAction} label="Check Jira now" pending="Reading…" icon={<RefreshCw aria-hidden />} />
          <SmallAction orgSlug={orgSlug} milestoneId={milestoneId} action={unlinkJiraIssueAction} label="Unlink the issue" pending="Unlinking…" icon={<Unlink aria-hidden />} />
          {/* The acceptance is taken back with its issue, before any payment (JR13), not by revoking the milestone by hand. */}
          {view.state === "accepted" && <p className="basis-full text-xs text-ink-3">To take the acceptance back, unlink the issue: the milestone then waits for verification again.</p>}
        </div>
      )}
    </div>
  );
}
