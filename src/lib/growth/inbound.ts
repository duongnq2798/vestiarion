import "server-only";
import { z } from "zod";
import { platformDb } from "@/lib/dal";
import { escapeHtml } from "@/lib/email/html";
import { sendEmail } from "@/lib/email/send";
import { publicOrigin } from "@/lib/public-origin";
import { masterKeysFromEnv, type MasterKey } from "@/lib/secrets";
import { X_HANDLE } from "@/lib/site-links";
import { parseFirstTouch } from "./attribution";
import { firstIssue } from "./forms";
import {
  arrivalLabel,
  checkGuidedSetupToken,
  contractorsLabel,
  guidedSetupSchema,
  HONEYPOT_FIELD,
  inboundLead,
  MAX_SUBMISSION_CHARS,
  TOKEN_FIELD,
  type GuidedSetupField,
  type GuidedSetupRequest,
} from "./guided-setup";

/**
 * The guided setup request on /studios, from the form's fields to one row in growth_leads (docs: ARCHITECTURE.md,
 * "Growth tracking for the team"). It writes through growth_import_leads, the dashboard's own path, so the lead is
 * logged in growth_lead_events like an imported one and a dedupe key already taken is skipped, never overwritten. The
 * person is thanked either way. When GROWTH_INBOUND_NOTIFY_EMAIL is set, the team gets a short email about a new lead.
 * Nothing is sent to the person who asked.
 */

export interface GuidedSetupResult {
  ok: boolean;
  message: string;
  /** The field a refusal is about, so the form can mark it. */
  field?: GuidedSetupField;
}

export const THANKS = "Thanks — we'll be in touch.";
export const FAILED = `Something went wrong — please try again, or write to us on X ${X_HANDLE}.`;
export const EXPIRED = "This form was open too long. Reload the page and send it again.";

export interface GuidedSetupDeps {
  /** The vx_ft cookie's raw value, or null. */
  firstTouchCookie: string | null;
  keys?: () => MasterKey[];
  now?: () => Date;
  env?: Record<string, string | undefined>;
  send?: typeof sendEmail;
}

/** Every field's characters together, files counted by size. */
function submissionLength(formData: FormData): number {
  let total = 0;
  for (const [key, value] of formData.entries()) total += key.length + (typeof value === "string" ? value.length : value.size);
  return total;
}

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Whether the first touch's campaign is one the team set up; a database that cannot answer counts as no. */
async function campaignExists(id: string): Promise<boolean> {
  const { data, error } = await platformDb().from("growth_campaigns").select("id").eq("id", id).maybeSingle();
  if (error) {
    console.error("guided setup: campaign not read", error.message);
    return false;
  }
  return data !== null;
}

/** The team's email about a new request: who, how many contractors, how invoices arrive. Never the message. */
export function inboundNotice(request: GuidedSetupRequest, origin: string): { subject: string; html: string; text: string } {
  const subject = `Guided setup request: ${request.studio}`;
  const lines = [
    `${request.studio} asked for a guided setup on /studios.`,
    `Contractors paid a month: ${contractorsLabel(request.contractors)}`,
    `Invoices arrive by: ${arrivalLabel(request.arrival)}`,
    `It waits in the approval queue: ${origin}/admin/growth#approvals`,
  ];
  return { subject, text: lines.join("\n"), html: lines.map((part) => `<p>${escapeHtml(part)}</p>`).join("") };
}

async function notifyTeam(request: GuidedSetupRequest, env: Record<string, string | undefined>, send: typeof sendEmail): Promise<void> {
  const to = env.GROWTH_INBOUND_NOTIFY_EMAIL?.trim();
  if (!to) return;
  if (!z.email().safeParse(to).success) {
    console.warn("guided setup: GROWTH_INBOUND_NOTIFY_EMAIL is not an email address; no notice sent");
    return;
  }
  const result = await send({ to, ...inboundNotice(request, publicOrigin()) });
  if (!result.sent) console.error("guided setup: notice not sent", result.reason);
}

/**
 * Reads one submission and, when it is a person's and reads right, adds the lead. A bot (the honeypot filled, a token
 * missing, not ours or too fresh, a submission longer than any the form makes) is thanked and nothing is written.
 */
export async function submitGuidedSetup(formData: FormData, deps: GuidedSetupDeps): Promise<GuidedSetupResult> {
  const now = deps.now?.() ?? new Date();
  if (submissionLength(formData) > MAX_SUBMISSION_CHARS) return { ok: true, message: THANKS };
  if ((field(formData, HONEYPOT_FIELD) ?? "").trim() !== "") return { ok: true, message: THANKS };

  let keys: MasterKey[];
  try {
    keys = (deps.keys ?? masterKeysFromEnv)();
  } catch (error) {
    // A deployment that cannot check the token must not drop people's requests in silence.
    console.error("guided setup: master keys not read", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: FAILED };
  }
  const token = checkGuidedSetupToken(field(formData, TOKEN_FIELD) ?? "", keys, now.getTime());
  if (token === "expired") return { ok: false, message: EXPIRED };
  if (token !== "ok") return { ok: true, message: THANKS };

  const parsed = guidedSetupSchema.safeParse({
    name: field(formData, "name"),
    email: field(formData, "email"),
    studio: field(formData, "studio"),
    website: field(formData, "website"),
    contractors: field(formData, "contractors"),
    arrival: field(formData, "arrival"),
    message: field(formData, "message"),
  });
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    return { ok: false, message: firstIssue(parsed.error), ...(typeof path === "string" ? { field: path as GuidedSetupField } : {}) };
  }

  const touch = parseFirstTouch(deps.firstTouchCookie);
  const lead = inboundLead(parsed.data, touch, touch?.utm_campaign ? await campaignExists(touch.utm_campaign) : false, now.toISOString().slice(0, 10));
  const { data, error } = await platformDb().rpc("growth_import_leads", { p_rows: [lead], p_by: null });
  if (error) {
    console.error("guided setup: lead not saved", error.message);
    return { ok: false, message: FAILED };
  }
  const added = z.array(z.string()).safeParse(data);
  // A studio that asked before keeps its lead as it is; this one is thanked all the same.
  if (added.success && added.data.length > 0) await notifyTeam(parsed.data, deps.env ?? process.env, deps.send ?? sendEmail);
  return { ok: true, message: THANKS };
}
