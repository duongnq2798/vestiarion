import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAutoRefresh } from "@/lib/auto-refresh";

/**
 * The timing behind <AutoRefresh>: re-read the page on an interval while it is
 * visible, and as soon as the person comes back to it, but never twice within
 * a few seconds and never while the tab is hidden.
 */

let visible = true;
let notify: (() => void) | null = null;
let unsubscribed = false;

function start(intervalMs = 15_000) {
  const refresh = vi.fn();
  const stop = startAutoRefresh({
    refresh,
    intervalMs,
    isVisible: () => visible,
    subscribe: (onChange) => {
      notify = onChange;
      return () => {
        unsubscribed = true;
      };
    },
  });
  return { refresh, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  notify = null;
  unsubscribed = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startAutoRefresh", () => {
  it("does not refresh on start: the page was just rendered", () => {
    const { refresh } = start();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once per interval while the page is visible", () => {
    const { refresh } = start(15_000);
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("skips the intervals that pass while the page is hidden", () => {
    const { refresh } = start(15_000);
    visible = false;
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes at once when the person comes back after a while", () => {
    const { refresh } = start(60_000);
    visible = false;
    vi.advanceTimersByTime(20_000);
    visible = true;
    notify?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh again on focus within 5 seconds of the last one", () => {
    const { refresh } = start(60_000);
    vi.advanceTimersByTime(3_000);
    notify?.();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    notify?.();
    expect(refresh).toHaveBeenCalledTimes(1);
    notify?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a change that leaves the page hidden", () => {
    const { refresh } = start(60_000);
    vi.advanceTimersByTime(10_000);
    visible = false;
    notify?.();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops the interval and the listener when stopped", () => {
    const { refresh, stop } = start(15_000);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(unsubscribed).toBe(true);
  });
});

describe("the Members page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "members", "page.tsx"), "utf8");

  it("re-reads itself every 15 s while an invitation is open, and every minute otherwise", () => {
    expect(page).toContain("<AutoRefresh intervalMs={invitations.length > 0 ? 15_000 : 60_000} />");
  });
});
