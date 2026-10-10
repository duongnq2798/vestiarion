"use server";

import "server-only";

import { cookies } from "next/headers";
import { FIRST_TOUCH_COOKIE } from "@/lib/growth/attribution";
import { submitGuidedSetup, type GuidedSetupResult } from "@/lib/growth/inbound";

/**
 * The guided setup request on /studios. A visitor has no account, so there is no session or workspace to gate on: the
 * request's own checks are the gate (the honeypot, the signed form token, the length cap, then every field), all in
 * `submitGuidedSetup`, which writes one growth lead through the platform database and nothing in any workspace.
 */
export async function requestGuidedSetupAction(_previous: GuidedSetupResult, formData: FormData): Promise<GuidedSetupResult> {
  return submitGuidedSetup(formData, { firstTouchCookie: (await cookies()).get(FIRST_TOUCH_COOKIE)?.value ?? null });
}
