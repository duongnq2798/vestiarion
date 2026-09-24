import { describe, expect, it, vi } from "vitest";
import { cycleClockMode } from "@/lib/clock";
import { parseGitHubPullRequestUrl, verifyGitHubPullRequest } from "@/lib/github-verification";

describe("GitHub pull request source parsing", () => {
  it("accepts and canonicalizes a GitHub PR URL", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/openai/example/pull/42?diff=split#discussion")).toEqual({
      owner: "openai",
      repo: "example",
      number: 42,
      url: "https://github.com/openai/example/pull/42",
    });
  });

  it.each([
    "http://github.com/openai/example/pull/42",
    "https://evil.example/openai/example/pull/42",
    "https://github.com/openai/example/issues/42",
    "https://github.com/openai/example/pull/0",
    "deliverable:github-pr#42",
    "",
  ])("rejects non-PR source %s", (source) => {
    expect(parseGitHubPullRequestUrl(source)).toBeNull();
  });
});

describe("GitHub pull request verification", () => {
  const ref = parseGitHubPullRequestUrl("https://github.com/openai/example/pull/42")!;

  it("degrades explicitly without a token and does not call the network", async () => {
    const fetchImpl = vi.fn();
    await expect(verifyGitHubPullRequest(ref, { token: "", fetchImpl })).resolves.toMatchObject({
      status: "unavailable",
      reason: "GITHUB_TOKEN is not configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a merged response as verified and records the merge time", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      merged: true,
      merged_at: "2026-09-24T05:00:00Z",
      state: "closed",
    }), { status: 200 }));
    const result = await verifyGitHubPullRequest(ref, { token: "test-token", fetchImpl });
    expect(result).toMatchObject({ status: "verified", mergedAt: "2026-09-24T05:00:00Z", state: "closed" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/openai/example/pulls/42");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("does not verify an open or unmerged PR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      merged: false,
      merged_at: null,
      state: "open",
    }), { status: 200 }));
    await expect(verifyGitHubPullRequest(ref, { token: "test-token", fetchImpl })).resolves.toMatchObject({
      status: "not_merged",
      mergedAt: null,
      state: "open",
    });
  });

  it("returns failed rather than an invented verdict on API or schema errors", async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(verifyGitHubPullRequest(ref, { token: "test-token", fetchImpl: unavailable })).resolves.toMatchObject({
      status: "failed",
      reason: "GitHub returned HTTP 429",
    });

    const malformed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ merged: "yes" }), { status: 200 }));
    await expect(verifyGitHubPullRequest(ref, { token: "test-token", fetchImpl: malformed })).resolves.toMatchObject({
      status: "failed",
      reason: "GitHub returned an invalid pull request response",
    });
  });
});

describe("cycle clock mode", () => {
  it("uses wall-clock mode by default in production", () => {
    expect(cycleClockMode({ NODE_ENV: "production" })).toBe("real");
  });

  it("keeps numbered days by default in development and tests", () => {
    expect(cycleClockMode({ NODE_ENV: "development" })).toBe("simulate");
    expect(cycleClockMode({ NODE_ENV: "test" })).toBe("simulate");
  });

  it("honors either explicit mode and ignores unsafe values", () => {
    expect(cycleClockMode({ NODE_ENV: "production", CYCLE_CLOCK_MODE: "simulate" })).toBe("simulate");
    expect(cycleClockMode({ NODE_ENV: "development", CYCLE_CLOCK_MODE: " REAL " })).toBe("real");
    expect(cycleClockMode({ NODE_ENV: "production", CYCLE_CLOCK_MODE: "tomorrow" })).toBe("real");
  });
});
