import { readConnection } from "./connections";

/**
 * What Settings shows of a workspace's Discord (docs/superpowers/specs/2026-10-22-discord-design.md DC6): whether this
 * deployment has it yet, the webhook's name and channel, when it was connected and whether by the viewer, and the last
 * post Discord did not take. Never the URL, its token or its envelope: this crosses into a client component.
 */
export type DiscordPanelView =
  | { available: false }
  | { available: true; connected: false }
  | {
      available: true;
      connected: true;
      name: string;
      channelId: string;
      connectedAt: string;
      /** Whether the viewer connected it: the page reads no other member's email for it. */
      connectedByYou: boolean;
      lastError: string | null;
      lastErrorAt: string | null;
    };

export async function discordPanelView(orgId: string, userId: string): Promise<DiscordPanelView> {
  const read = await readConnection(orgId);
  if (!read.ready) return { available: false };
  const { connection } = read;
  if (!connection) return { available: true, connected: false };
  return {
    available: true,
    connected: true,
    name: connection.name,
    channelId: connection.channelId,
    connectedAt: connection.connectedAt,
    connectedByYou: connection.connectedBy === userId,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt,
  };
}
