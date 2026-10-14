import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { NotSetUpError } from "../connectors/connections";
import { AsanaNotSetUpError, asanaReady } from "./links";
import { asanaProvider } from "./provider";
import type { AsanaSettings } from "./settings";

/**
 * Asana's connect flow as the routes run it (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2): the
 * deployment's own origin, whose callback is registered for the app as
 * https://www.vestiarion.xyz/api/integrations/asana/callback, and a check that migration 0115 has run before anyone goes
 * to Asana. Nothing is read at once: a task is read when a person links it to a milestone.
 */
export function asanaConnectDeps(settings: AsanaSettings): ConnectDeps {
  return {
    provider: asanaProvider(settings),
    origin: siteOrigin(),
    ready: async () => {
      try {
        await asanaReady();
      } catch (error) {
        if (error instanceof AsanaNotSetUpError) throw new NotSetUpError();
        throw error;
      }
    },
  };
}
