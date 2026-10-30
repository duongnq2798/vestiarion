import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { NotSetUpError } from "../connectors/connections";
import { LinearNotSetUpError, linearReady } from "./links";
import { linearProvider } from "./provider";
import type { LinearSettings } from "./settings";

/**
 * Linear's connect flow as the routes run it (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2): the
 * deployment's own origin, whose callback is registered for the app as
 * https://www.vestiarion.xyz/api/integrations/linear/callback, and a check that migration 0147 has run before anyone
 * goes to Linear. Nothing is read at once: an issue is read when a person links it to a milestone.
 */
export function linearConnectDeps(settings: LinearSettings): ConnectDeps {
  return {
    provider: linearProvider(settings),
    origin: siteOrigin(),
    ready: async () => {
      try {
        await linearReady();
      } catch (error) {
        if (error instanceof LinearNotSetUpError) throw new NotSetUpError();
        throw error;
      }
    },
  };
}
