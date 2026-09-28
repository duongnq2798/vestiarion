import { describe, expect, it } from "vitest";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "@/lib/agent/sandbox-cap";

describe("sandbox cap constants", () => {
  it("SANDBOX_DAILY_CYCLES is 20", () => {
    expect(SANDBOX_DAILY_CYCLES).toBe(20);
  });

  it("SandboxCapReachedError quotes SANDBOX_DAILY_CYCLES and when it resets", () => {
    expect(new SandboxCapReachedError().message).toBe(
      "This sandbox has run its 20 cycles for today (UTC). It resets at midnight UTC."
    );
  });
});
