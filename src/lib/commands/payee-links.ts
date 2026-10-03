import { db, unwrap } from "../dal";
import { createPayeeLink, PayeeLinkError } from "../platform/payee-links";
import { publicOrigin } from "../public-origin";
import { provenanceOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Makes a one-time link for a payee to enter their own address (payee links design §2; write API part 2, W3, W4): the
 * console's Create link and `POST /api/v1/payee-links`. A payee link asks someone the agent pays for their address; a
 * client is never paid, and the public page would tell them otherwise. The address the payee enters waits for a
 * member's confirmation before the agent pays to it. The link's address is in the outcome only: just its hash is
 * stored, and the error log names nothing of it.
 */
export async function issuePayeeLink(
  actor: Actor,
  input: { counterpartyId: string }
): Promise<CommandOutcome<{ linkId: string; counterpartyId: string; url: string; expiresAt: string }>> {
  const refusal = gate(actor, "payee_link.create");
  if (refusal) return refusal;
  try {
    const found = unwrap(await db().from("counterparties").select("id, role").eq("id", input.counterpartyId).limit(1)) as Array<{ id: string; role: string }>;
    if (found.length === 0) return refused("counterparty_not_found", "Counterparty not found.");
    if (found[0].role === "client") return refused("client", "A payee link is for a vendor or a contractor the agent pays.");

    const { link, token } = await createPayeeLink({ orgId: actor.orgId, actorId: actor.userId, counterpartyId: input.counterpartyId, ...provenanceOf(actor) });
    return done("Link created. Copy it now: it is shown only once.", {
      linkId: link.id,
      counterpartyId: link.counterpartyId,
      url: `${publicOrigin()}/payee/${token}`,
      expiresAt: link.expiresAt,
    });
  } catch (error) {
    if (error instanceof PayeeLinkError) return refused("counterparty_not_found", error.message);
    console.error("payee link creation failed");
    return refused("failed", TRY_AGAIN);
  }
}
