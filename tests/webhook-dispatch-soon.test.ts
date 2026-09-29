import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ledger append sends its webhooks right after the response, once per burst
 * (webhooks design W3, as amended). `after` is recorded rather than run, so a
 * test can see what was scheduled and run it when it chooses.
 */
const { deferred, afterMode } = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  afterMode: { value: "record" as "record" | "throw" },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      if (afterMode.value === "throw") throw new Error("`after` was called outside a request scope");
      deferred.push(task);
    },
  };
});

const deliver = vi.hoisted(() => vi.fn(async () => ({ delivered: 1, failed: 0, retried: 0 })));
vi.mock("@/lib/webhooks/deliver", () => ({ deliverPendingWebhooks: deliver }));

import { DISPATCH_SOON_MS, dispatchWebhooksSoon, resetDispatchSoonForTests } from "@/lib/webhooks/dispatch-soon";

beforeEach(() => {
  deferred.length = 0;
  afterMode.value = "record";
  deliver.mockClear();
  resetDispatchSoonForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("dispatchWebhooksSoon", () => {
  it("schedules one dispatch after the response, bounded by its own deadline", async () => {
    dispatchWebhooksSoon();
    expect(deferred).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();

    await deferred[0]();
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ deadlineMs: DISPATCH_SOON_MS });
  });

  it("lets a burst of appends share the dispatch that has not started yet", async () => {
    dispatchWebhooksSoon();
    dispatchWebhooksSoon();
    dispatchWebhooksSoon();
    expect(deferred).toHaveLength(1);

    await deferred[0]();
    dispatchWebhooksSoon();
    expect(deferred).toHaveLength(2);
  });

  it("does nothing outside a request, and schedules again once a request can take it", () => {
    afterMode.value = "throw";
    expect(() => dispatchWebhooksSoon()).not.toThrow();
    expect(deferred).toHaveLength(0);

    afterMode.value = "record";
    dispatchWebhooksSoon();
    expect(deferred).toHaveLength(1);
  });

  it("swallows a failed dispatch, so nothing after the response throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.mockRejectedValueOnce(new Error("boom"));
    dispatchWebhooksSoon();
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("webhook dispatch after the request failed");
  });
});
