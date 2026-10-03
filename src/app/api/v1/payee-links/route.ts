import { NextResponse } from "next/server";
import { z } from "zod";
import { guardApiWrite, handleApiRequest } from "@/lib/api/guard";
import { CreatePayeeLinkBodySchema } from "@/lib/api/schemas";
import { invalidBody, readJsonBody, refusalResponse } from "@/lib/api/write";
import { issuePayeeLink } from "@/lib/commands/payee-links";

export const dynamic = "force-dynamic";

/** The id the body names, checked before anything is read. */
const LinkInputSchema = z.object({ counterpartyId: z.string().uuid() });

/** What each of `issuePayeeLink`'s own refusals answers: the body named a payee it cannot be. */
const REFUSALS = {
  counterparty_not_found: "counterpartyId: No counterparty with this id in this workspace.",
  client: "counterpartyId: A payee link is for a vendor or a contractor the agent pays.",
};

/**
 * Makes a one-time payee link (docs/superpowers/specs/2026-10-03-write-api-part-2-design.md W1, W3): a read-and-write
 * key's request, through the same `issuePayeeLink` the console runs, as the key's issuer's. The address the payee
 * enters waits for a member's confirmation before the agent pays to it.
 *
 * The link's address is in this answer only, which no cache may keep. Only its hash is stored, so no outcome is kept
 * for an `Idempotency-Key`: keeping one would store the link. A repeat makes a new link, which revokes the unused one.
 */
export async function POST(request: Request) {
  const guard = await guardApiWrite(request);
  if ("denied" in guard) return guard.denied;
  const body = await readJsonBody(request);
  if ("denied" in body) return body.denied;

  const shape = CreatePayeeLinkBodySchema.safeParse(body.value);
  if (!shape.success) return invalidBody(shape.error);
  const parsed = LinkInputSchema.safeParse(shape.data);
  if (!parsed.success) return invalidBody(parsed.error);
  const { counterpartyId } = parsed.data;

  return handleApiRequest("POST /api/v1/payee-links", guard.key, async () => {
    const made = await issuePayeeLink(guard.actor, { counterpartyId });
    if (!made.ok) return refusalResponse(made, REFUSALS);
    return NextResponse.json(
      { data: { id: made.linkId, counterpartyId: made.counterpartyId, url: made.url, expiresAt: made.expiresAt } },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  });
}
