import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendNoticesSoon } from "@/lib/payment-notices-soon";

/**
 * What a person's payment owes, sent after the response (payment notices R5): the payee's email, and the comment on the
 * pull request a milestone was paid for (GitHub App design G4), so a person's Pay now is said on GitHub at once rather
 * than at the next cycle. A sandbox owes neither.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { notices: vi.fn(), comments: vi.fn(), tasks: [] as Array<() => Promise<unknown>> } }));
vi.mock("next/server", () => ({ after: (task: () => Promise<unknown>) => mocks.tasks.push(task) }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: (_orgId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/payment-notices", () => ({ sendPaymentNotices: mocks.notices }));
vi.mock("@/lib/github/payment-comments", () => ({ sendPullRequestComments: mocks.comments }));

const live = { user: { id: "u-1" }, membership: { orgId: "o-1", mode: "live" as const } };

beforeEach(() => {
  mocks.notices.mockReset().mockResolvedValue([]);
  mocks.comments.mockReset().mockResolvedValue([]);
  mocks.tasks.length = 0;
});

describe("sendNoticesSoon", () => {
  it("sends the payee's notice and the pull request's comment after the response", async () => {
    sendNoticesSoon(live);
    expect(mocks.notices).not.toHaveBeenCalled();
    await Promise.all(mocks.tasks.map((task) => task()));
    expect(mocks.notices).toHaveBeenCalledTimes(1);
    expect(mocks.comments).toHaveBeenCalledTimes(1);
  });

  it("still comments when the notice fails, and still notifies when the comment fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.notices.mockRejectedValueOnce(new Error("email down"));
    sendNoticesSoon(live);
    await Promise.all(mocks.tasks.map((task) => task()));
    expect(mocks.comments).toHaveBeenCalledTimes(1);

    mocks.tasks.length = 0;
    mocks.comments.mockRejectedValueOnce(new Error("GitHub answered HTTP 502"));
    sendNoticesSoon(live);
    await Promise.all(mocks.tasks.map((task) => task()));
    expect(mocks.notices).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("owes nothing for a sandbox's simulated payment", () => {
    sendNoticesSoon({ ...live, membership: { ...live.membership, mode: "sandbox" } });
    expect(mocks.tasks).toEqual([]);
  });
});
