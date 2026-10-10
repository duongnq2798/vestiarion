import "server-only";
import { cookies } from "next/headers";
import { platformDb } from "@/lib/dal";
import { FIRST_TOUCH_COOKIE, parseFirstTouch } from "./attribution";

/** How long creating a workspace waits for its first touch to be recorded before going on without it. */
export const RECORD_TIMEOUT_MS = 1500;

/**
 * Records a new workspace's first touch from the request's `vx_ft` cookie, once (record_org_attribution, migration
 * 0099). Never fails and never holds up onboarding for long: no cookie, an unreadable one, a database error or a slow
 * answer is logged at most, and the workspace is there either way.
 */
export async function recordFirstTouch(orgId: string): Promise<void> {
  try {
    const touch = parseFirstTouch((await cookies()).get(FIRST_TOUCH_COOKIE)?.value);
    if (!touch) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), RECORD_TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.resolve(platformDb().rpc("record_org_attribution", { p_org: orgId, p_attr: touch })), timeout]);
    clearTimeout(timer);
    if (result === "timeout") console.error("first touch: not recorded in time");
    else if (result.error) console.error("first touch: not recorded", result.error.message);
  } catch (error) {
    console.error("first touch: not recorded", error instanceof Error ? error.message : "unknown error");
  }
}
