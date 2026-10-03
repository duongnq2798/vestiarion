import type { NextResponse } from "next/server";
import type { z } from "zod";
import type { Refused } from "../commands/outcome";
import { apiError, INTERNAL_MESSAGE } from "./guard";

/**
 * What every write operation does with a request's body before anything is written (write API R2, R7): read it once,
 * at most 64 KB, as one JSON object, and answer a field that does not validate with `400 invalid_request` naming it.
 * Nothing here is remembered for an `Idempotency-Key`: a body that fails these checks never starts a write (R5).
 */

/** The largest body a write accepts. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(request: Request): Promise<{ raw: string; value: Record<string, unknown> } | { denied: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { denied: apiError("invalid_request", `The body is larger than ${MAX_BODY_BYTES / 1024} KB.`) };
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { denied: apiError("invalid_request", `The body is larger than ${MAX_BODY_BYTES / 1024} KB.`) };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { denied: apiError("invalid_request", "The body must be JSON.") };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { denied: apiError("invalid_request", "The body must be a JSON object.") };
  }
  return { raw, value: value as Record<string, unknown> };
}

/**
 * The first problem with a body, as `<field>: <what is wrong>`. A field the operation does not take is named too.
 * `fields` gives a console form's field the name the API uses for it, where the two differ.
 */
export function invalidBody(error: z.ZodError, fields: Record<string, string> = {}): NextResponse {
  const issue = error.issues[0];
  if (!issue) return apiError("invalid_request", "The body is not valid.");
  if (issue.code === "unrecognized_keys") {
    return apiError("invalid_request", `${[...issue.path, issue.keys[0]].join(".")}: is not a field this operation takes.`);
  }
  const path = issue.path.join(".");
  return apiError("invalid_request", `${fields[path] ?? (path || "body")}: ${issue.message}`);
}

/**
 * A command's refusal, as a write answers it (write API part 2, W4). A refusal the operation names in `invalid` is the
 * body's, `400` with the field it is about. One the gate made is the key's, `403`: the guard has already checked the
 * issuer, so only a role changed since then gets here. Anything else failed, and answers the API's own `500`, which
 * an `Idempotency-Key` does not keep.
 */
export function refusalResponse(refusal: Refused, invalid: Record<string, string>): NextResponse {
  const message = invalid[refusal.code];
  if (message) return apiError("invalid_request", message);
  if (refusal.code === "forbidden" || refusal.code === "surface") {
    return apiError("forbidden", "This key's issuer can no longer add records in this workspace.");
  }
  return apiError("internal", INTERNAL_MESSAGE);
}
