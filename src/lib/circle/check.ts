import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { withDeadline } from "./settlement";

/**
 * The Circle calls that checking a key, provisioning wallets and proving
 * credentials belong to the entity that holds the wallets (`getWallet`,
 * `getWalletSet`) make.
 */
export type CircleClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "listWalletSets" | "createWalletSet" | "createWallets" | "getWallet" | "getWalletSet"
>;

/** Builds a Circle client from one organization's credentials. Tests pass a fake; production uses the SDK's. */
export type CircleClientFactory = (credentials: { apiKey: string; entitySecret: string }) => CircleClient;

export const defaultCircleClient: CircleClientFactory = (credentials) => initiateDeveloperControlledWalletsClient(credentials);

export type CircleCheck = "ok" | "rejected" | "unreachable";

const KEY_CHECK_DEADLINE_MS = 10_000;

/**
 * The HTTP status of a failed Circle call, or undefined when there was no
 * answer (a network failure, a deadline) or the failure is not an HTTP one.
 *
 * The SDK catches every Axios failure and rethrows it as its own error class
 * (`fromAxiosError`): an `HttpResponseError` subclass — `UnauthorizedError`,
 * `ForbiddenError`, `InternalServerError`, or one per Circle error code —
 * carrying the HTTP `status` on the error itself, or an `HttpRequestError`
 * subclass (`ConnectionRefusedError`, ...) with no status at all. The raw
 * Axios error survives only behind the SDK error's `error` getter. A raw
 * Axios error, with `response.status`, is read too, in case a call ever
 * escapes that wrapping.
 */
export function circleHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof status === "number") return status;
  if (typeof response?.status === "number") return response.status;
  return undefined;
}

/**
 * What a failed Circle call may put in a log line: its HTTP status or its
 * network error code. Never its message, nor the error object — the SDK's
 * error keeps the Axios error, whose request config holds the API key in its
 * Authorization header.
 */
export function circleFailureLabel(error: unknown): string {
  const status = circleHttpStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "no answer";
}

/**
 * Whether Circle accepts an API key, from one read that needs a valid key.
 *
 * A 401 or 403 is Circle refusing the key. Anything else — no answer within
 * 10 s, a network failure, a 5xx, a rate limit — says nothing about the key,
 * so the owner is told to try again rather than that the key is wrong.
 *
 * The entity secret is not checked here: a read does not use it, and only a
 * write can prove it. Provisioning does that (`EntitySecretRejected`).
 */
export async function checkCircleApiKey(
  apiKey: string,
  entitySecret: string,
  client: CircleClientFactory = defaultCircleClient
): Promise<CircleCheck> {
  try {
    await withDeadline(
      client({ apiKey, entitySecret }).listWalletSets(),
      KEY_CHECK_DEADLINE_MS,
      `no answer from Circle listWalletSets within ${KEY_CHECK_DEADLINE_MS} ms`
    );
    return "ok";
  } catch (error) {
    const status = circleHttpStatus(error);
    if (status === 401 || status === 403) return "rejected";
    console.warn("circle: API key check could not reach Circle", circleFailureLabel(error));
    return "unreachable";
  }
}
