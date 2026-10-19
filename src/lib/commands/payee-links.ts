import { db, unwrap } from "../dal";
import { chainChoiceFits, choosablePayeeChains, payeesHeldToTheirChain } from "../payee-chain-choice";
import { createPayeeLink, PayeeLinkError, type PayeeLinkOptions } from "../platform/payee-links";
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
 *
 * `options` (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P1), from the console only: also ask for the
 * payee's invoice, and let the payee choose where it is paid, which only a vendor with no address yet, and nothing owed
 * to it held to its chain, may be offered, in a workspace that can pay more than one chain. Every other surface makes a
 * link with both off.
 */
export async function issuePayeeLink(
  actor: Actor,
  input: { counterpartyId: string; options?: PayeeLinkOptions }
): Promise<CommandOutcome<{ linkId: string; counterpartyId: string; url: string; expiresAt: string }>> {
  const refusal = gate(actor, "payee_link.create");
  if (refusal) return refusal;
  try {
    const found = unwrap(await db().from("counterparties").select("id, role, address").eq("id", input.counterpartyId).limit(1)) as Array<{
      id: string;
      role: string;
      address: string | null;
    }>;
    if (found.length === 0) return refused("counterparty_not_found", "Counterparty not found.");
    if (found[0].role === "client") return refused("client", "A payee link is for a vendor or a contractor the agent pays.");

    const asksInvoice = input.options?.asksInvoice === true;
    const offersChain = input.options?.offersChain === true;
    if (offersChain) {
      const held = chainChoiceFits(found[0], new Set()) ? await payeesHeldToTheirChain([found[0].id]) : new Set([found[0].id]);
      if (!chainChoiceFits(found[0], held) || (await choosablePayeeChains()).length === 0) {
        return refused(
          "chain_not_offered",
          "Only a vendor with no address yet, and no milestone or bill in another currency than USDC still open, can choose where it is paid, and only where this workspace pays more than one chain."
        );
      }
    }
    const options = asksInvoice || offersChain ? { options: { ...(asksInvoice ? { asksInvoice } : {}), ...(offersChain ? { offersChain } : {}) } } : {};
    const { link, token } = await createPayeeLink({ orgId: actor.orgId, actorId: actor.userId, counterpartyId: input.counterpartyId, ...provenanceOf(actor), ...options });
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
