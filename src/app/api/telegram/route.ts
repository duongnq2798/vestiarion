import { timingSafeEqual } from "node:crypto";
import { siteOrigin } from "@/lib/auth/env";
import { telegramClient } from "@/lib/telegram/client";
import { telegramSettingsFromEnv } from "@/lib/telegram/settings";
import { handleUpdate } from "@/lib/telegram/updates";

/**
 * The Telegram bot's webhook (docs/superpowers/specs/2026-10-03-telegram-bot-design.md, R1, R2). Not there unless the
 * bot is configured; closed unless the request carries the secret Telegram was given in `setWebhook`. Each update is
 * handled before the answer, which is 200 whatever happened inside, so Telegram never redelivers an update in a loop;
 * every handler can run twice without harm.
 */

export const dynamic = "force-dynamic";
/** A PDF read by the model, then a reply, fits well inside a minute. */
export const maxDuration = 60;

function secretMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const updateIdOf = (update: unknown) =>
  typeof update === "object" && update !== null && "update_id" in update ? (update as { update_id: unknown }).update_id : null;

export async function POST(request: Request): Promise<Response> {
  const settings = telegramSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), settings.webhookSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return Response.json({ ok: true });
  }
  try {
    await handleUpdate(update, { client: telegramClient(settings), origin: siteOrigin() });
  } catch (error) {
    // The update's id, never its text: a message can carry an invoice.
    console.error("telegram: update failed", updateIdOf(update), error instanceof Error ? error.message : "unknown error");
  }
  return Response.json({ ok: true });
}
